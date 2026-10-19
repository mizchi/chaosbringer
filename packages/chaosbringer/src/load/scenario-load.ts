/**
 * Top-level scenario-load runner. Launches one shared Chromium, spins
 * up N workers (one Playwright context each), and lets each worker
 * loop its scenario until the duration deadline elapses or the
 * per-worker iteration cap is hit.
 *
 * The design point is "**light** load (10 workers, 1–5min) combined
 * with chaos injection". For full load-testing throughput (100+
 * workers, p99 SLOs, time-windowed RPS) reach for k6 or Artillery —
 * this runner is biased toward bugs-under-realistic-concurrency, not
 * RPS optimisation.
 */
import { chromium, type Browser, type BrowserContext } from "playwright";
import { collectorInitScript } from "lightbringer/core";
import {
  buildRuntimeFaultsScript,
  compileRuntimeFaults,
  mergeRuntimeStats,
} from "../runtime-faults.js";
import {
  compileLoadFaultRules,
  faultFiringsFrom,
  faultStatsFrom,
  installFaultRoutes,
} from "./fault-routes.js";
import { parseDurationMs } from "./histogram.js";
import { resolveLoadPerf, sampledWorkerIndexes } from "./perf-stats.js";
import { buildLoadReport } from "./report.js";
import {
  abortedNavigation,
  type DocumentRequest,
  UnreachableStreak,
  watchDocumentRequests,
} from "./unreachable.js";
import { cancellableSleep, ScenarioWorker, type WorkerSamples } from "./worker.js";
import type { ScenarioLoadOptions, ScenarioSpec, LoadReport, LoadStop } from "./types.js";

export interface ScenarioLoadResult {
  report: LoadReport;
  /** Per-fault rule injection stats (network faults only). */
  faultStats: ReturnType<typeof faultStatsFrom>;
}

const DEFAULT_DURATION_MS = 60_000;
/**
 * Iterations in a row that could not connect to `baseUrl` before the run
 * stops. Few: five workers of a run pointed at a down host fail their first
 * iterations together, and the run says so at once instead of failing for
 * its whole duration.
 */
const DEFAULT_STOP_ON_UNREACHABLE = 3;

interface PlannedWorker {
  workerIndex: number;
  spec: ScenarioSpec;
  storageState: string | undefined;
  startOffsetMs: number;
}

function planWorkers(
  scenarios: ReadonlyArray<ScenarioSpec>,
  rampUpMs: number,
): PlannedWorker[] {
  const out: PlannedWorker[] = [];
  for (const spec of scenarios) {
    if (spec.workers <= 0) continue;
    for (let i = 0; i < spec.workers; i++) {
      const idx = out.length;
      let storage: string | undefined;
      if (typeof spec.storageState === "string") storage = spec.storageState;
      else if (typeof spec.storageState === "function") {
        storage = spec.storageState(i) ?? undefined;
      }
      out.push({
        workerIndex: idx,
        spec,
        storageState: storage,
        startOffsetMs: 0,
      });
    }
  }
  if (out.length > 0 && rampUpMs > 0) {
    // Linearly spread starts across rampUpMs. Worker 0 starts at t=0,
    // worker N-1 starts at t≈rampUpMs.
    const step = rampUpMs / Math.max(1, out.length - 1);
    out.forEach((w, i) => {
      w.startOffsetMs = Math.round(step * i);
    });
  }
  return out;
}

function summariseRuntimeFaultStats(
  compiled: ReturnType<typeof compileRuntimeFaults>,
): ReadonlyArray<{ rule: string; matched: number; fired: number }> {
  return compiled.map((c) => ({
    rule: c.name,
    matched: c.matched,
    fired: c.fired,
  }));
}

export async function scenarioLoad(
  options: ScenarioLoadOptions,
): Promise<ScenarioLoadResult> {
  if (options.scenarios.length === 0) {
    throw new Error("scenarioLoad: scenarios is empty");
  }
  const durationMs = options.duration !== undefined
    ? parseDurationMs(options.duration)
    : DEFAULT_DURATION_MS;
  const rampUpMs = options.rampUp !== undefined ? parseDurationMs(options.rampUp) : 0;
  // Resolved before anything launches, so an unsupported level fails fast.
  const perf = resolveLoadPerf(options.perf);
  const planned = planWorkers(options.scenarios, rampUpMs);
  if (planned.length === 0) {
    throw new Error("scenarioLoad: every scenario spec had workers <= 0");
  }
  const sampled = perf
    ? sampledWorkerIndexes(planned, perf.sampleWorkers)
    : new Set<number>();

  const compiledFaultRules = compileLoadFaultRules(options.faultInjection);
  const compiledRuntimeFaults = compileRuntimeFaults(
    options.runtimeFaults ? [...options.runtimeFaults] : undefined,
  );
  // Runtime faults need an RNG seed for stable pseudo-random firing
  // across the run. Load runs are not deterministic, so a fresh seed
  // per run is correct here.
  const runtimeSeed = Math.floor(Math.random() * 0x7fffffff);
  const runtimeFaultScript = compiledRuntimeFaults.length > 0
    ? buildRuntimeFaultsScript(compiledRuntimeFaults.map((c) => c.fault), runtimeSeed)
    : null;

  const unreachableLimit = options.stopOnUnreachable ?? DEFAULT_STOP_ON_UNREACHABLE;
  if (
    unreachableLimit !== false &&
    (!Number.isInteger(unreachableLimit) || unreachableLimit < 1)
  ) {
    throw new Error(
      `scenarioLoad: stopOnUnreachable must be a positive integer or false, got ${unreachableLimit}`,
    );
  }
  const unreachable = unreachableLimit === false
    ? null
    : new UnreachableStreak(options.baseUrl, unreachableLimit);

  const startTime = Date.now();
  const deadline = startTime + durationMs;
  // The first stop asked for wins; workers see it at their next step boundary.
  let stopped = undefined as LoadStop | undefined;
  const stopRun = (cause: LoadStop["cause"], reason: string) => {
    stopped ??= { cause, reason, at: Date.now() };
  };
  const shouldStop = () => stopped !== undefined || Date.now() >= deadline;
  const onIterationEnd = (failure: string | null, sent: DocumentRequest | null) => {
    const reason = unreachable?.record(failure, sent);
    if (reason) stopRun("unreachable", reason);
  };

  const browser = await chromium.launch({ headless: options.headless ?? true });
  try {
    const workers = planned.map((p) => {
      // The URLs of the navigations a `faultInjection` rule aborted during
      // this worker's iteration. A net error at one of them is the fault's,
      // not the host's: a chaos run aborting the document with
      // `connectionrefused` would otherwise stop as "unreachable" within
      // seconds while the host is up. Such an iteration neither counts
      // toward the streak nor resets it. Only that URL: one that went on
      // past an aborted provider page and then met a down host counts.
      const aborted: string[] = [];
      // The last document request of the worker's page, set with its context.
      let lastDocument: () => DocumentRequest | null = () => null;
      const contextHook = makeContextHook(
        compiledFaultRules,
        runtimeFaultScript,
        sampled.has(p.workerIndex),
        (url) => aborted.push(url),
      );
      return new ScenarioWorker({
        workerIndex: p.workerIndex,
        scenario: p.spec.scenario,
        baseUrl: options.baseUrl,
        defaultThinkTime: options.thinkTime,
        viewport: options.viewport,
        storageState: p.storageState,
        invariants: options.invariants,
        maxIterations: options.maxIterationsPerWorker,
        shouldStop,
        stopRun,
        onIterationEnd: (failure) => {
          const injected = aborted.splice(0);
          if (failure !== null && abortedNavigation(failure, injected)) return;
          onIterationEnd(failure, lastDocument());
        },
        perf: sampled.has(p.workerIndex),
        onContextCreated: async (context) => {
          lastDocument = watchDocumentRequests(context);
          await contextHook(context);
        },
      });
    });

    const runs: Promise<WorkerSamples>[] = workers.map(async (w, i) => {
      const delay = planned[i]!.startOffsetMs;
      if (delay > 0) {
        // Cancel the wait early if the deadline already fires during ramp-up,
        // or the run stopped: a worker due in 30s would hold its report back.
        const waitFor = Math.min(delay, Math.max(0, deadline - Date.now()));
        if (waitFor > 0) await cancellableSleep(waitFor, shouldStop);
      }
      if (shouldStop()) {
        // The run ended before this worker could start — return empty samples.
        return { steps: [], iterations: [], network: [], errors: [], runtimeFaultStats: {} };
      }
      return w.run(browser);
    });
    const samples = await Promise.all(runs);

    const endTime = Date.now();
    const report = buildLoadReport({
      baseUrl: options.baseUrl,
      startTime,
      endTime,
      durationMs: endTime - startTime,
      plannedDurationMs: durationMs,
      rampUpMs,
      planned,
      samples,
      timelineBucketMs: options.timelineBucketMs,
      faultFirings: faultFiringsFrom(compiledFaultRules),
      ...(perf ? { perf: { level: perf.level, sampledWorkers: sampled.size } } : {}),
      ...(stopped ? { stopped } : {}),
    });
    const faultStats = faultStatsFrom(compiledFaultRules);
    // Surface runtime fault stats in a side channel — runtime faults
    // don't fit the FaultInjectionStats shape, so we attach them as a
    // companion field via the report rather than expanding the type.
    if (runtimeFaultScript) {
      // Workers capture `window.__chaosbringerRuntimeStats` before
      // their context closes. Merge every worker's snapshot into the
      // compiled counters so `matched` / `fired` reflect actual
      // page-side firings, not zeroes.
      for (const s of samples) {
        if (s.runtimeFaultStats && Object.keys(s.runtimeFaultStats).length > 0) {
          mergeRuntimeStats(compiledRuntimeFaults, s.runtimeFaultStats);
        }
      }
      (report as LoadReport & { runtimeFaults?: unknown }).runtimeFaults =
        summariseRuntimeFaultStats(compiledRuntimeFaults);
    }
    return { report, faultStats };
  } finally {
    await browser.close().catch(() => {});
  }
}

function makeContextHook(
  compiledFaults: ReturnType<typeof compileLoadFaultRules>,
  runtimeScript: string | null,
  perf: boolean,
  onNavigationAbort: (url: string) => void,
): (context: BrowserContext) => Promise<void> {
  return async (context) => {
    // The collector goes first: init scripts run in registration order and it
    // captures the native clock when it runs, so after the runtime-fault
    // script a `clock-skew` fault would already have replaced it. Only
    // sampled workers get it — an unmeasured worker pays nothing.
    if (perf) {
      await context.addInitScript({ content: collectorInitScript() });
    }
    if (runtimeScript) {
      await context.addInitScript(runtimeScript);
    }
    await installFaultRoutes(context, compiledFaults, onNavigationAbort);
  };
}

// Workaround for circular import — Browser type only needed for runner glue.
void chromium;
void ({} as Browser);
