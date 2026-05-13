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
import { NetworkSampler, type NetworkSample } from "./sampler.js";
import { pickThinkTimeMs } from "./scenario.js";
import type { Scenario, ScenarioContext, ThinkTime } from "./types.js";
import type { Invariant } from "../types.js";

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
  /** Stop ASAP when this resolves (deadline reached). */
  shouldStop: () => boolean;
  /**
   * Pre-context hook — lets the runner wire in network fault routes /
   * runtime fault init-scripts before any scenario code runs. Called
   * once per worker on context create.
   */
  onContextCreated?: (context: BrowserContext) => Promise<void>;
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
  };
  private iteration = 0;

  constructor(private readonly opts: WorkerOptions) {}

  get workerIndex(): number {
    return this.opts.workerIndex;
  }

  async run(browser: Browser): Promise<WorkerSamples> {
    const contextOptions: Parameters<Browser["newContext"]>[0] = {};
    if (this.opts.viewport) contextOptions.viewport = this.opts.viewport;
    if (this.opts.storageState) contextOptions.storageState = this.opts.storageState;
    this.context = await browser.newContext(contextOptions);
    if (this.opts.onContextCreated) {
      await this.opts.onContextCreated(this.context);
    }
    this.page = await this.context.newPage();
    this.sampler.attach(this.page);

    try {
      while (!this.opts.shouldStop()) {
        if (
          this.opts.maxIterations !== undefined &&
          this.iteration >= this.opts.maxIterations
        ) {
          break;
        }
        await this.runIteration();
        this.iteration += 1;
      }
    } finally {
      this.samples.network.push(...this.sampler.drain());
      this.sampler.stop();
      await this.context.close().catch(() => {});
      this.context = null;
      this.page = null;
    }

    return this.samples;
  }

  private async runIteration(): Promise<void> {
    const scenario = this.opts.scenario;
    const page = this.page!;
    const ctx: ScenarioContext = {
      page,
      workerIndex: this.opts.workerIndex,
      iteration: this.iteration,
      baseUrl: this.opts.baseUrl,
    };
    const iterStart = performance.now();
    let iterationFailed = false;

    if (scenario.beforeIteration) {
      try {
        await scenario.beforeIteration(ctx);
      } catch (err) {
        this.recordError("beforeIteration", err);
        iterationFailed = true;
      }
    }

    if (!iterationFailed) {
      for (const step of scenario.steps) {
        if (this.opts.shouldStop()) break;
        const stepStart = performance.now();
        let stepFailed = false;
        try {
          await step.run(ctx);
          // Drain network samples accumulated during the step. Doing it
          // per-step (rather than per-iteration) keeps the buffer small
          // and lets the runner correlate samples to step boundaries.
          this.samples.network.push(...this.sampler.drain());
          await this.runInvariants(ctx);
        } catch (err) {
          this.recordError(step.name, err);
          stepFailed = true;
        }
        const stepEnd = performance.now();
        this.samples.steps.push({
          scenarioName: scenario.name,
          stepName: step.name,
          durationMs: stepEnd - stepStart,
          success: !stepFailed,
          iteration: this.iteration,
          timestamp: Date.now(),
        });
        if (stepFailed && !step.optional) {
          iterationFailed = true;
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
          await sleep(wait);
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

    const iterEnd = performance.now();
    this.samples.iterations.push({
      scenarioName: scenario.name,
      durationMs: iterEnd - iterStart,
      success: !iterationFailed,
      iteration: this.iteration,
      timestamp: Date.now(),
    });
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

  private recordError(stepName: string, err: unknown): void {
    this.samples.errors.push({
      scenarioName: this.opts.scenario.name,
      stepName,
      iteration: this.iteration,
      timestamp: Date.now(),
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
