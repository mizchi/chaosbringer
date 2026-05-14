/**
 * Public types for the scenario-load layer. A "scenario" is a
 * repeatable sequence of steps a virtual user performs. A "worker"
 * runs that scenario in a loop inside its own Playwright context
 * (clean cookies / storage) for the duration of the run.
 *
 * The layer is intentionally separate from the chaos crawler: the
 * crawler explores unknown UI, while this layer drives **known** user
 * journeys under realistic concurrency for load-correlated bug
 * detection. The two can run together — `scenarioLoad` accepts the
 * same `faultInjection` / `lifecycleFaults` / `invariants` options as
 * `chaos()`, so chaos can be injected while workers exercise the
 * happy path.
 */
import type { Page } from "playwright";
import type {
  Fault,
  FaultRule,
  LifecycleFault,
  RuntimeFault,
  Invariant,
} from "../types.js";

export interface ScenarioContext {
  page: Page;
  /** 0-based worker id. Useful for picking a per-worker storageState. */
  workerIndex: number;
  /** 0-based iteration counter inside this worker. */
  iteration: number;
  baseUrl: string;
}

export interface ScenarioStep {
  /** Stable label — used in the LoadReport's per-step rollup. */
  name: string;
  /** The action. Throw to mark the step (and its iteration) failed. */
  run: (ctx: ScenarioContext) => Promise<void>;
  /**
   * Per-step think time override. Falls back to scenario-level
   * `thinkTime` if absent, then to the runner default.
   */
  thinkTime?: ThinkTime;
  /** If true, a failure does NOT abort the iteration. Default: false. */
  optional?: boolean;
}

export interface ThinkTime {
  /** Minimum wait in ms. Default: 1000. */
  minMs?: number;
  /** Maximum wait in ms. Default: 3000. */
  maxMs?: number;
  /**
   * Distribution shape. `uniform` (default) is `min + rand * (max-min)`.
   * `none` disables waiting (use for batch traffic). `gaussian` clusters
   * around the midpoint with σ = (max-min)/4, clamped.
   */
  distribution?: "uniform" | "none" | "gaussian";
}

export interface Scenario {
  name: string;
  steps: ReadonlyArray<ScenarioStep>;
  /** Default think time between steps for this scenario. */
  thinkTime?: ThinkTime;
  /** Optional per-iteration setup (e.g. navigate to start URL). */
  beforeIteration?: (ctx: ScenarioContext) => Promise<void>;
  /** Optional per-iteration teardown. Runs even when an iteration failed. */
  afterIteration?: (ctx: ScenarioContext) => Promise<void>;
}

export interface ScenarioSpec {
  scenario: Scenario;
  /** How many workers run this scenario concurrently. */
  workers: number;
  /**
   * Filesystem path to a Playwright `storageState.json`, or a per-worker
   * factory. When omitted, every worker starts in a clean (logged-out)
   * context.
   */
  storageState?: string | ((workerIndex: number) => string | undefined);
}

export type DurationInput = number | `${number}ms` | `${number}s` | `${number}m`;

export interface ScenarioLoadOptions {
  baseUrl: string;
  scenarios: ReadonlyArray<ScenarioSpec>;
  /**
   * Total wall-clock budget for the run. Workers stop cleanly at their
   * next step boundary once this deadline is reached. Default: 60s.
   */
  duration?: DurationInput;
  /**
   * Workers stagger their startup over this window (linearly). Default: 0
   * (all workers start at once). Use a few seconds to avoid an initial
   * thundering-herd masking steady-state behaviour.
   */
  rampUp?: DurationInput;
  /** Default think time when scenario / step don't specify one. */
  thinkTime?: ThinkTime;
  /** Run headless. Default: true. */
  headless?: boolean;
  /** Default viewport. Mirrors CrawlerOptions.viewport. */
  viewport?: { width: number; height: number };

  /** Chaos integration — same shape as `chaos()`. */
  faultInjection?: ReadonlyArray<FaultRule | Fault>;
  lifecycleFaults?: ReadonlyArray<LifecycleFault>;
  runtimeFaults?: ReadonlyArray<RuntimeFault>;
  /** Invariants run after every step. A failure is recorded as a step error. */
  invariants?: ReadonlyArray<Invariant>;

  /** Hard cap on iterations per worker (overrides duration). */
  maxIterationsPerWorker?: number;
  /**
   * Bucket width for the timeline in `LoadReport`. Default: 1000ms.
   * Smaller buckets are finer-grained but blow up the report size linearly.
   */
  timelineBucketMs?: number;
}

// -------- Report shape --------

export interface LatencyStats {
  count: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
}

export interface StepReport {
  name: string;
  /** Total step executions across all workers in this scenario. */
  invocations: number;
  failures: number;
  errorRate: number;
  latency: LatencyStats;
}

export interface ScenarioReport {
  name: string;
  workers: number;
  iterations: number;
  iterationFailures: number;
  /** iterations / duration_seconds across the run. */
  throughputPerSec: number;
  steps: StepReport[];
}

export interface EndpointReport {
  /** URL pattern key — usually the bare path (query-stripped). */
  key: string;
  count: number;
  errorCount: number;
  status: Record<string, number>;
  latency: LatencyStats;
}

export interface WorkerSummary {
  workerIndex: number;
  scenarioName: string;
  iterations: number;
  iterationFailures: number;
  /** Final iteration end timestamp; null if the worker never finished one. */
  lastIterationAt: number | null;
}

/**
 * One bucket of the per-second timeline. Buckets are aligned to the
 * run's start time, so `tMs` is the offset in ms from `LoadReport.startTime`
 * to the bucket's beginning. Buckets with zero activity are included
 * (so consumers see gaps as gaps, not as missing data).
 */
export interface TimelineBucket {
  tMs: number;
  iterations: number;
  iterationFailures: number;
  networkRequests: number;
  networkErrors: number;
  /**
   * Per-fault-rule firing counts inside this bucket. Keyed by rule
   * name (`FaultRule.name`, falling back to `fault-${index}`). Empty
   * object when no faults are configured. Lets you literally read
   * cause-and-effect on the same axis as `iterations` / `errors`.
   */
  faults: Record<string, number>;
}

export interface LoadReport {
  baseUrl: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  config: {
    workers: number;
    rampUpMs: number;
    durationMs: number;
  };
  totals: {
    iterations: number;
    iterationFailures: number;
    stepFailures: number;
    networkRequests: number;
    networkErrors: number;
  };
  scenarios: ScenarioReport[];
  workers: WorkerSummary[];
  endpoints: EndpointReport[];
  /**
   * Per-bucket timeline of iteration / error rates. Bucket width is
   * `timelineBucketMs` from the runner options (default 1000ms). Useful
   * for correlating chaos with throughput dips — `chaos starts at t=30s,
   * throughput drops in bucket 30 → recovers at bucket 45`.
   */
  timeline: TimelineBucket[];
  /** Errors collected per worker, capped to avoid runaway reports. */
  errors: ReadonlyArray<{
    workerIndex: number;
    scenarioName: string;
    stepName: string;
    iteration: number;
    timestamp: number;
    message: string;
  }>;
}
