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
import { buildRuntimeFaultsScript, compileRuntimeFaults } from "../runtime-faults.js";
import { compileLoadFaultRules, faultStatsFrom, installFaultRoutes } from "./fault-routes.js";
import { parseDurationMs } from "./histogram.js";
import { buildLoadReport } from "./report.js";
import { ScenarioWorker, type WorkerSamples } from "./worker.js";
import type { ScenarioLoadOptions, ScenarioSpec, LoadReport } from "./types.js";

export interface ScenarioLoadResult {
  report: LoadReport;
  /** Per-fault rule injection stats (network faults only). */
  faultStats: ReturnType<typeof faultStatsFrom>;
}

const DEFAULT_DURATION_MS = 60_000;

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
  const planned = planWorkers(options.scenarios, rampUpMs);
  if (planned.length === 0) {
    throw new Error("scenarioLoad: every scenario spec had workers <= 0");
  }

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

  const startTime = Date.now();
  const deadline = startTime + durationMs;
  const shouldStop = () => Date.now() >= deadline;

  const browser = await chromium.launch({ headless: options.headless ?? true });
  try {
    const workers = planned.map(
      (p) =>
        new ScenarioWorker({
          workerIndex: p.workerIndex,
          scenario: p.spec.scenario,
          baseUrl: options.baseUrl,
          defaultThinkTime: options.thinkTime,
          viewport: options.viewport,
          storageState: p.storageState,
          invariants: options.invariants,
          maxIterations: options.maxIterationsPerWorker,
          shouldStop,
          onContextCreated: makeContextHook(compiledFaultRules, runtimeFaultScript),
        }),
    );

    const runs: Promise<WorkerSamples>[] = workers.map(async (w, i) => {
      const delay = planned[i]!.startOffsetMs;
      if (delay > 0) {
        // Cancel the wait early if the deadline already fires during ramp-up.
        const waitFor = Math.min(delay, Math.max(0, deadline - Date.now()));
        if (waitFor > 0) await sleep(waitFor);
      }
      if (shouldStop()) {
        // Deadline fired before this worker could start — return empty samples.
        return { steps: [], iterations: [], network: [], errors: [] };
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
    });
    const faultStats = faultStatsFrom(compiledFaultRules);
    // Surface runtime fault stats in a side channel — runtime faults
    // don't fit the FaultInjectionStats shape, so we attach them as a
    // companion field via the report rather than expanding the type.
    if (runtimeFaultScript) {
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
): (context: BrowserContext) => Promise<void> {
  return async (context) => {
    if (runtimeScript) {
      await context.addInitScript(runtimeScript);
    }
    await installFaultRoutes(context, compiledFaults);
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Workaround for circular import — Browser type only needed for runner glue.
void chromium;
void ({} as Browser);
