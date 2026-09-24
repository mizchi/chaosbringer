/**
 * Pure aggregation of the sampled workers' step spans. The worker records one
 * `WorkerPerfSample` per measured step; everything that turns those into the
 * report's per-step stats and per-bucket series lives here, so it is testable
 * without a browser (the same split as `report.ts` / `histogram.ts`).
 */
import { quantile } from "./histogram.js";
import type { PerfQuantiles, ScenarioLoadPerfOptions, StepPerfStats } from "./types.js";

/** One measured step execution, trimmed to what the load report aggregates. */
export interface WorkerPerfSample {
  scenarioName: string;
  stepName: string;
  /** Wall-clock timestamp at step end — the same clock as `WorkerStepSample`. */
  timestamp: number;
  durationMs: number;
  blockingMs: number;
  /** The span's worst interaction latency; absent when it had none. */
  interactionMs?: number;
}

export const DEFAULT_PERF_SAMPLE_WORKERS = 1;

/** `ScenarioLoadOptions.perf` with its defaults filled in, or null when off. */
export interface ResolvedLoadPerf {
  level: "light";
  sampleWorkers: number;
}

/**
 * Resolve and validate `perf`. Throws on `level: "trace"` (a trace per worker
 * is too heavy for a load run — see `ScenarioLoadOptions.perf`) and on a
 * `sampleWorkers` that is not a positive integer: `0` would be `perf: false`
 * said confusingly, and a fraction has no meaning for a worker count.
 */
export function resolveLoadPerf(
  perf: boolean | ScenarioLoadPerfOptions | undefined,
): ResolvedLoadPerf | null {
  if (perf === undefined || perf === false) return null;
  const opts: ScenarioLoadPerfOptions = perf === true ? {} : perf;
  const level = (opts as { level?: string }).level ?? "light";
  if (level !== "light") {
    throw new Error(
      `scenarioLoad: perf.level "${level}" is not supported — only "light". ` +
        "A trace per load worker is too heavy: it streams to disk and loads the " +
        "renderer every worker shares, distorting the concurrency it measures.",
    );
  }
  const sampleWorkers = opts.sampleWorkers ?? DEFAULT_PERF_SAMPLE_WORKERS;
  if (!Number.isInteger(sampleWorkers) || sampleWorkers < 1) {
    throw new Error(
      `scenarioLoad: perf.sampleWorkers must be a positive integer (got ${sampleWorkers})`,
    );
  }
  return { level: "light", sampleWorkers };
}

function sortedAsc(values: ReadonlyArray<number>): number[] {
  return [...values].sort((a, b) => a - b);
}

/** p50 / p95 of `values`; zeros for an empty input. */
export function perfQuantiles(values: ReadonlyArray<number>): PerfQuantiles {
  if (values.length === 0) return { p50: 0, p95: 0 };
  const sorted = sortedAsc(values);
  return { p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95) };
}

/**
 * Stats for one step over its measured executions; undefined for none, so a
 * step no sampled worker reached carries no `perf` rather than a zeroed one
 * that reads as "cost nothing".
 */
export function stepPerfStats(samples: ReadonlyArray<WorkerPerfSample>): StepPerfStats | undefined {
  if (samples.length === 0) return undefined;
  const interactions = samples
    .map((s) => s.interactionMs)
    .filter((v): v is number => v !== undefined);
  return {
    n: samples.length,
    durationMs: perfQuantiles(samples.map((s) => s.durationMs)),
    blockingMs: perfQuantiles(samples.map((s) => s.blockingMs)),
    ...(interactions.length > 0
      ? { interactionMs: { n: interactions.length, ...perfQuantiles(interactions) } }
      : {}),
  };
}

/**
 * Which planned workers measure: the first `sampleWorkers` of each scenario
 * spec, in plan order. Per spec rather than run-wide, so a run with two
 * scenarios measures both instead of spending every sample on the first.
 */
export function sampledWorkerIndexes<S>(
  planned: ReadonlyArray<{ workerIndex: number; spec: S }>,
  sampleWorkers: number,
): Set<number> {
  const perSpec = new Map<S, number>();
  const out = new Set<number>();
  for (const p of planned) {
    const taken = perSpec.get(p.spec) ?? 0;
    if (taken >= sampleWorkers) continue;
    perSpec.set(p.spec, taken + 1);
    out.add(p.workerIndex);
  }
  return out;
}
