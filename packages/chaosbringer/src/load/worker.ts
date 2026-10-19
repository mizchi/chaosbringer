/**
 * A `ScenarioWorker` is one virtual user. It owns one Playwright
 * context (clean cookies / storage isolated from other workers),
 * loops its scenario until either the deadline or its iteration cap
 * fires, and accumulates timing samples + errors for the runner to
 * aggregate.
 *
 * Each worker creates its context lazily on `run()` and tears it down
 * on `stop()`. The browser itself is owned by the runner and shared
 * across workers — one Chromium process for the whole load run keeps
 * memory bounded at ~10× lower than per-worker-browser.
 */
import type { Browser, BrowserContext, Page } from "playwright";
import type { SpanHandle } from "lightbringer/core";
import type { WorkerPerfSample } from "./perf-stats.js";
import { NetworkSampler, type NetworkSample } from "./sampler.js";
import { StepPerf } from "./step-perf.js";
import { pickThinkTimeMs } from "./scenario.js";
import type { LoadStop, Scenario, ScenarioContext, ScenarioStep, ThinkTime } from "./types.js";
import type { Invariant } from "../types.js";
import { contextOptions, installKeepNamesHelper } from "../browser-session.js";

/**
 * The least a worker waits after a failed iteration, whatever the think time
 * says (`distribution: "none"` says 0). A step that fails at once — a host
 * that refuses the connection, a store with nothing left to replay — would
 * otherwise loop as fast as it can throw, tens of thousands of times a second.
 */
const FAILED_ITERATION_BACKOFF_MS = 100;

export interface WorkerStepSample {
  scenarioName: string;
  stepName: string;
  durationMs: number;
  success: boolean;
  /** Worker-local iteration counter (0-based). */
  iteration: number;
  /** Wall-clock timestamp at step end. */
  timestamp: number;
}

export interface WorkerIterationSample {
  scenarioName: string;
  durationMs: number;
  success: boolean;
  iteration: number;
  timestamp: number;
}

export interface WorkerError {
  scenarioName: string;
  stepName: string;
  iteration: number;
  timestamp: number;
  message: string;
}

export interface WorkerSamples {
  steps: WorkerStepSample[];
  iterations: WorkerIterationSample[];
  network: NetworkSample[];
  errors: WorkerError[];
  /**
   * Snapshot of `window.__chaosbringerRuntimeStats` captured just
   * before the worker's BrowserContext closes. Indexed by stringified
   * compiled-runtime-fault id (same shape `mergeRuntimeStats` consumes).
   * Empty when runtime faults weren't configured for this worker.
   */
  runtimeFaultStats: Record<string, { matched: number; fired: number }>;
  /** One sample per measured step; absent unless this worker was sampled. */
  perf?: WorkerPerfSample[];
  /**
   * Iterations the deadline cut short: started, then stopped before a step
   * that would have run. They are not in `iterations` — they finished no
   * scenario, and counting one as a successful iteration would pair an
   * iteration count with step counts that never reached it — but the steps
   * they did run are in `steps` (and `perf`), each a complete measurement.
   * Absent when none was.
   */
  truncatedIterations?: number;
}

export interface WorkerOptions {
  workerIndex: number;
  scenario: Scenario;
  baseUrl: string;
  defaultThinkTime?: ThinkTime;
  viewport?: { width: number; height: number };
  storageState?: string;
  invariants?: ReadonlyArray<Invariant>;
  maxIterations?: number;
  /** Stop ASAP when this resolves (deadline reached, or the run stopped). */
  shouldStop: () => boolean;
  /**
   * Ends the run for every worker: the runner records the stop and
   * `shouldStop` turns true. Steps reach it as `ctx.stopRun`.
   */
  stopRun?: (cause: LoadStop["cause"], reason: string) => void;
  /**
   * Called as each finished iteration is recorded: the message of the error
   * that failed it, or `null` when it succeeded. Not called for an iteration
   * the deadline cut short.
   */
  onIterationEnd?: (failure: string | null) => void;
  /**
   * Pre-context hook — lets the runner wire in network fault routes /
   * runtime fault init-scripts before any scenario code runs. Called
   * once per worker on context create.
   */
  onContextCreated?: (context: BrowserContext) => Promise<void>;
  /**
   * Measure every step as a lightbringer span. The runner sets it on the
   * sampled workers only, and has already installed the collector on the
   * context this worker's hook receives.
   */
  perf?: boolean;
}

export class ScenarioWorker {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private sampler = new NetworkSampler();
  private readonly samples: WorkerSamples = {
    steps: [],
    iterations: [],
    network: [],
    errors: [],
    runtimeFaultStats: {},
  };
  private iteration = 0;
  private stepPerf: StepPerf | null = null;

  constructor(private readonly opts: WorkerOptions) {}

  get workerIndex(): number {
    return this.opts.workerIndex;
  }

  async run(browser: Browser): Promise<WorkerSamples> {
    this.context = await browser.newContext(
      contextOptions({
        ...(this.opts.viewport ? { viewport: this.opts.viewport } : {}),
        ...(this.opts.storageState ? { storageState: this.opts.storageState } : {}),
      }),
    );
    await installKeepNamesHelper(this.context);
    if (this.opts.onContextCreated) {
      await this.opts.onContextCreated(this.context);
    }
    this.page = await this.context.newPage();
    this.sampler.attach(this.page);
    if (this.opts.perf) {
      // A worker whose session cannot open still generates its share of the
      // load; it just reports no browser-side cost.
      this.stepPerf = await StepPerf.open(this.page).catch(() => null);
    }

    try {
      while (!this.opts.shouldStop() && !this.capped()) {
        const backoffMs = await this.runIteration();
        this.iteration += 1;
        if (backoffMs > 0 && !this.capped()) {
          await cancellableSleep(backoffMs, this.opts.shouldStop);
        }
      }
    } finally {
      this.pushNetwork();
      this.sampler.stop();
      // Capture runtime fault stats from the in-page counter before
      // tearing down the context. Best-effort: page may already be in
      // an error state, in which case we leave the {} default.
      if (this.page) {
        try {
          const pageStats = await this.page.evaluate(() =>
            (globalThis as {
              __chaosbringerRuntimeStats?: Record<string, { matched: number; fired: number }>;
            }).__chaosbringerRuntimeStats ?? {},
          );
          if (pageStats && typeof pageStats === "object") {
            this.samples.runtimeFaultStats = pageStats;
          }
        } catch {
          // ignored — diagnostics, not load-bearing
        }
      }
      if (this.stepPerf) {
        this.samples.perf = await this.stepPerf.finish();
        this.stepPerf = null;
      }
      await this.context.close().catch(() => {});
      this.context = null;
      this.page = null;
    }

    return this.samples;
  }

  private capped(): boolean {
    return this.opts.maxIterations !== undefined && this.iteration >= this.opts.maxIterations;
  }

  /**
   * Moves the sampler's buffer into the samples one by one: a spread passes
   * every sample as an argument, and the buffer of a long run whose steps
   * kept failing (only a passing step drains it) overflows the call stack.
   */
  private pushNetwork(): void {
    for (const sample of this.sampler.drain()) this.samples.network.push(sample);
  }

  /** Runs one iteration; returns how long to wait before the next (0 after a success). */
  private async runIteration(): Promise<number> {
    const scenario = this.opts.scenario;
    const page = this.page!;
    const ctx: ScenarioContext = {
      page,
      workerIndex: this.opts.workerIndex,
      iteration: this.iteration,
      baseUrl: this.opts.baseUrl,
      stopRun: (reason) => this.opts.stopRun?.("scenario", reason),
    };
    const iterStart = performance.now();
    let iterationFailed = false;
    // What failed the iteration: the error's message, and the step (absent
    // for `beforeIteration`) whose think time the backoff starts from.
    let failure: string | null = null;
    let failedStep: ScenarioStep | undefined;
    // The deadline fired with steps of this iteration still to run.
    let truncated = false;

    if (scenario.beforeIteration) {
      try {
        await scenario.beforeIteration(ctx);
      } catch (err) {
        failure = this.recordError("beforeIteration", err);
        iterationFailed = true;
      }
    }

    if (!iterationFailed) {
      for (const step of scenario.steps) {
        if (this.opts.shouldStop()) {
          truncated = true;
          break;
        }
        // The span opens before the wall-clock start and closes after the
        // wall-clock end, so lightbringer's own CDP round-trips never count
        // toward the step latency the SLOs read.
        const span: SpanHandle | null = this.stepPerf
          ? await this.stepPerf.begin(step.name).catch(() => null)
          : null;
        const stepStart = performance.now();
        let stepError: string | null = null;
        try {
          await step.run(ctx);
          // Drain network samples accumulated during the step. Doing it
          // per-step (rather than per-iteration) keeps the buffer small
          // and lets the runner correlate samples to step boundaries.
          this.pushNetwork();
          await this.runInvariants(ctx);
        } catch (err) {
          stepError = this.recordError(step.name, err);
        }
        const stepFailed = stepError !== null;
        const stepEnd = performance.now();
        const timestamp = Date.now();
        this.samples.steps.push({
          scenarioName: scenario.name,
          stepName: step.name,
          durationMs: stepEnd - stepStart,
          success: !stepFailed,
          iteration: this.iteration,
          timestamp,
        });
        if (span && this.stepPerf) {
          // A failed step is measured too: what it cost the browser before it
          // failed is part of the load the page saw.
          await this.stepPerf
            .end(span, { scenarioName: scenario.name, stepName: step.name, timestamp })
            .catch(() => {});
        }
        if (stepFailed && !step.optional) {
          iterationFailed = true;
          failure = stepError;
          failedStep = step;
          break;
        }
        // pickThinkTimeMs applies arguments left-to-right, so most-general
        // goes first and most-specific last so step-level overrides win.
        const wait = pickThinkTimeMs(
          this.opts.defaultThinkTime,
          scenario.thinkTime,
          step.thinkTime,
        );
        if (wait > 0 && !this.opts.shouldStop()) {
          await cancellableSleep(wait, this.opts.shouldStop);
        }
      }
    }

    if (scenario.afterIteration) {
      try {
        await scenario.afterIteration(ctx);
      } catch (err) {
        this.recordError("afterIteration", err);
      }
    }

    if (truncated) {
      // Left out of `iterations` (see `WorkerSamples.truncatedIterations`):
      // its duration covers only part of the scenario and its success says
      // nothing about the steps that never ran.
      this.samples.truncatedIterations = (this.samples.truncatedIterations ?? 0) + 1;
      return 0;
    }

    const iterEnd = performance.now();
    this.samples.iterations.push({
      scenarioName: scenario.name,
      durationMs: iterEnd - iterStart,
      success: !iterationFailed,
      iteration: this.iteration,
      timestamp: Date.now(),
    });
    this.opts.onIterationEnd?.(failure);
    if (!iterationFailed) return 0;
    // The think time the failed step would have waited, and at least the
    // floor. Waited between iterations, so the failed one's duration does
    // not include it.
    return Math.max(
      FAILED_ITERATION_BACKOFF_MS,
      pickThinkTimeMs(this.opts.defaultThinkTime, scenario.thinkTime, failedStep?.thinkTime),
    );
  }

  private invariantState = new Map<string, unknown>();

  private async runInvariants(ctx: ScenarioContext): Promise<void> {
    if (!this.opts.invariants || this.opts.invariants.length === 0) return;
    for (const inv of this.opts.invariants) {
      // Scenarios run every invariant after every step. `when` is
      // ignored — the load runner has no page-lifecycle phases, only
      // step boundaries.
      const result = await inv.check({
        page: ctx.page,
        url: ctx.page.url(),
        errors: [],
        state: this.invariantState,
      });
      if (result === true || result === undefined) continue;
      const message = typeof result === "string" ? result : `[${inv.name}] failed`;
      throw new Error(message);
    }
  }

  /** Records `err` against the current iteration; returns its message. */
  private recordError(stepName: string, err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    this.samples.errors.push({
      scenarioName: this.opts.scenario.name,
      stepName,
      iteration: this.iteration,
      timestamp: Date.now(),
      message,
    });
    return message;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleep that exits early when the deadline fires or the run stops. Polls
 * in short chunks so a worker doesn't continue thinking past the configured
 * `duration` — without this, total run time can overshoot by up to
 * `thinkTime.maxMs` per worker, skewing throughput / error stats.
 *
 * 50ms chunk is fine-grained enough for any reasonable load run
 * (deadline detection latency ≤ 50ms) without burning CPU on small
 * thinkTimes.
 */
export async function cancellableSleep(ms: number, shouldStop: () => boolean): Promise<void> {
  const CHUNK = 50;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (shouldStop()) return;
    await sleep(Math.min(CHUNK, deadline - Date.now()));
  }
}
