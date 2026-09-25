/**
 * Aggregate per-worker samples into a `LoadReport`. Pure: takes
 * collected samples + run config, returns a single report. Kept
 * separate from `scenario-load.ts` so it can be tested without
 * launching a browser.
 *
 * Also exports a small ASCII formatter for terminal output —
 * mirroring the style of `formatReport` in `reporter.ts` so the two
 * report families read similarly.
 */
import { emptyLatencyStats, latencyStats } from "./histogram.js";
import { perfQuantiles, stepPerfStats, type WorkerPerfSample } from "./perf-stats.js";
import type { NetworkSample } from "./sampler.js";
import type { WorkerSamples } from "./worker.js";
import type {
  EndpointReport,
  LoadReport,
  ScenarioReport,
  ScenarioSpec,
  StepReport,
  TimelineBucket,
  WorkerSummary,
} from "./types.js";

const MAX_ERRORS_IN_REPORT = 200;
const DEFAULT_TIMELINE_BUCKET_MS = 1000;

export interface BuildLoadReportInput {
  baseUrl: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  plannedDurationMs: number;
  rampUpMs: number;
  /** `startOffsetMs` (ramp-up) feeds `TimelinePerf.startedWorkers`; 0 when absent. */
  planned: ReadonlyArray<{ workerIndex: number; spec: ScenarioSpec; startOffsetMs?: number }>;
  samples: ReadonlyArray<WorkerSamples>;
  /** Default 1000ms. Values <= 0 disable the timeline (returned empty). */
  timelineBucketMs?: number;
  /**
   * Per-fault-rule wall-clock firing timestamps. Keys appear in the
   * `faults` map of every TimelineBucket (zero for buckets where the
   * rule didn't fire) so consumers can read row × column.
   */
  faultFirings?: Record<string, ReadonlyArray<number>>;
  /**
   * Set when `perf` was on. Turns on the per-bucket `perf` block even when no
   * sampled worker recorded a span, so the report says "measured, nothing
   * seen" rather than looking unmeasured.
   */
  perf?: { level: "light"; sampledWorkers: number };
}

export function buildLoadReport(input: BuildLoadReportInput): LoadReport {
  const seconds = input.durationMs / 1000;
  const scenarios: ScenarioReport[] = [];
  const seenScenarioNames = new Set<string>();

  // Group samples by scenario name.
  const byScenario = new Map<string, {
    workerCount: number;
    iterations: WorkerSamples["iterations"];
    steps: WorkerSamples["steps"];
    perf: WorkerPerfSample[];
    truncated: number;
  }>();
  for (let i = 0; i < input.planned.length; i++) {
    const plan = input.planned[i]!;
    const samples = input.samples[i]!;
    const name = plan.spec.scenario.name;
    const entry = byScenario.get(name) ?? { workerCount: 0, iterations: [], steps: [], perf: [], truncated: 0 };
    entry.workerCount += 1;
    entry.iterations.push(...samples.iterations);
    entry.truncated += samples.truncatedIterations ?? 0;
    entry.steps.push(...samples.steps);
    if (samples.perf) entry.perf.push(...samples.perf);
    byScenario.set(name, entry);
    seenScenarioNames.add(name);
  }

  for (const [name, group] of byScenario) {
    const stepsByName = new Map<string, { latencies: number[]; failures: number }>();
    for (const s of group.steps) {
      const e = stepsByName.get(s.stepName) ?? { latencies: [], failures: 0 };
      e.latencies.push(s.durationMs);
      if (!s.success) e.failures += 1;
      stepsByName.set(s.stepName, e);
    }
    const perfByStep = new Map<string, WorkerPerfSample[]>();
    for (const p of group.perf) {
      const list = perfByStep.get(p.stepName) ?? [];
      list.push(p);
      perfByStep.set(p.stepName, list);
    }
    const stepReports: StepReport[] = [];
    for (const [stepName, e] of stepsByName) {
      const perf = stepPerfStats(perfByStep.get(stepName) ?? []);
      stepReports.push({
        name: stepName,
        invocations: e.latencies.length,
        failures: e.failures,
        errorRate: e.latencies.length > 0 ? e.failures / e.latencies.length : 0,
        latency: latencyStats(e.latencies),
        ...(perf ? { perf } : {}),
      });
    }
    const iterationFailures = group.iterations.filter((i) => !i.success).length;
    scenarios.push({
      name,
      workers: group.workerCount,
      iterations: group.iterations.length,
      iterationFailures,
      ...(group.truncated > 0 ? { truncatedIterations: group.truncated } : {}),
      throughputPerSec: seconds > 0 ? group.iterations.length / seconds : 0,
      steps: stepReports,
    });
  }

  // Workers summary.
  const workers: WorkerSummary[] = input.planned.map((plan, i) => {
    const samples = input.samples[i]!;
    const last = samples.iterations.length > 0
      ? samples.iterations[samples.iterations.length - 1]!.timestamp
      : null;
    return {
      workerIndex: plan.workerIndex,
      scenarioName: plan.spec.scenario.name,
      iterations: samples.iterations.length,
      iterationFailures: samples.iterations.filter((it) => !it.success).length,
      ...(samples.truncatedIterations ? { truncatedIterations: samples.truncatedIterations } : {}),
      lastIterationAt: last,
    };
  });

  // Endpoint aggregation.
  const endpointMap = new Map<string, {
    samples: number[];
    errors: number;
    status: Record<string, number>;
  }>();
  let totalNetwork = 0;
  let totalNetworkErrors = 0;
  for (const s of input.samples) {
    for (const n of s.network) {
      totalNetwork += 1;
      if (isNetworkError(n)) totalNetworkErrors += 1;
      const e = endpointMap.get(n.key) ?? { samples: [], errors: 0, status: {} };
      e.samples.push(n.durationMs);
      if (isNetworkError(n)) e.errors += 1;
      const key = String(n.status);
      e.status[key] = (e.status[key] ?? 0) + 1;
      endpointMap.set(n.key, e);
    }
  }
  const endpoints: EndpointReport[] = [];
  for (const [key, e] of endpointMap) {
    endpoints.push({
      key,
      count: e.samples.length,
      errorCount: e.errors,
      status: e.status,
      latency: latencyStats(e.samples),
    });
  }
  endpoints.sort((a, b) => b.count - a.count);

  // Errors — capped flat list, sorted by timestamp.
  const errors = input.samples
    .flatMap((s, i) =>
      s.errors.map((e) => ({
        workerIndex: input.planned[i]!.workerIndex,
        scenarioName: e.scenarioName,
        stepName: e.stepName,
        iteration: e.iteration,
        timestamp: e.timestamp,
        message: e.message,
      })),
    )
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(0, MAX_ERRORS_IN_REPORT);

  const truncatedIterations = scenarios.reduce((a, s) => a + (s.truncatedIterations ?? 0), 0);
  const totals = {
    iterations: scenarios.reduce((a, s) => a + s.iterations, 0),
    iterationFailures: scenarios.reduce((a, s) => a + s.iterationFailures, 0),
    ...(truncatedIterations > 0 ? { truncatedIterations } : {}),
    stepFailures: scenarios.reduce(
      (a, s) => a + s.steps.reduce((b, st) => b + st.failures, 0),
      0,
    ),
    networkRequests: totalNetwork,
    networkErrors: totalNetworkErrors,
  };

  // Fix up empty-stat objects so consumers can read latency.* without
  // null-checking when nothing was sampled.
  for (const s of scenarios) {
    for (const st of s.steps) if (st.latency.count === 0) st.latency = emptyLatencyStats();
  }

  const timeline = buildTimeline({
    startTime: input.startTime,
    durationMs: input.durationMs,
    bucketMs: input.timelineBucketMs ?? DEFAULT_TIMELINE_BUCKET_MS,
    samples: input.samples,
    faultFirings: input.faultFirings,
    perfStartOffsetsMs: input.perf
      ? input.planned.map((p) => p.startOffsetMs ?? 0)
      : undefined,
  });

  return {
    baseUrl: input.baseUrl,
    startTime: input.startTime,
    endTime: input.endTime,
    durationMs: input.durationMs,
    config: {
      workers: input.planned.length,
      rampUpMs: input.rampUpMs,
      durationMs: input.plannedDurationMs,
      ...(input.perf ? { perf: input.perf } : {}),
    },
    totals,
    scenarios,
    workers,
    endpoints,
    timeline,
    errors,
  };
}

interface BuildTimelineInput {
  startTime: number;
  durationMs: number;
  bucketMs: number;
  samples: ReadonlyArray<WorkerSamples>;
  faultFirings?: Record<string, ReadonlyArray<number>>;
  /** Every planned worker's ramp-up start offset; set only when perf is on. */
  perfStartOffsetsMs?: ReadonlyArray<number>;
}

/**
 * Bucket iterations + network events by `timestamp - startTime`.
 * Returns one zero-filled bucket per `bucketMs` from t=0 up to (but
 * not past) `durationMs`. Events landing outside the window are
 * dropped silently — they're rare (timer skew) and the alternative
 * (allowing trailing buckets) makes the consumer reason about a
 * variable-length axis.
 */
function buildTimeline(input: BuildTimelineInput): TimelineBucket[] {
  if (input.bucketMs <= 0 || input.durationMs <= 0) return [];
  const bucketCount = Math.max(1, Math.ceil(input.durationMs / input.bucketMs));
  const ruleNames = input.faultFirings ? Object.keys(input.faultFirings) : [];
  const buckets: TimelineBucket[] = [];
  for (let i = 0; i < bucketCount; i++) {
    // Pre-fill every rule's count to 0 so consumers see a stable
    // key set per-bucket — `bucket.faults["api-500"] ?? 0` is annoying
    // to write everywhere if some buckets omit the key.
    const faults: Record<string, number> = {};
    for (const name of ruleNames) faults[name] = 0;
    buckets.push({
      tMs: i * input.bucketMs,
      iterations: 0,
      iterationFailures: 0,
      networkRequests: 0,
      networkErrors: 0,
      faults,
    });
  }
  const indexFor = (timestamp: number): number | null => {
    const offset = timestamp - input.startTime;
    if (offset < 0) return null;
    const idx = Math.floor(offset / input.bucketMs);
    if (idx >= bucketCount) return null;
    return idx;
  };
  for (const s of input.samples) {
    for (const it of s.iterations) {
      const idx = indexFor(it.timestamp);
      if (idx === null) continue;
      buckets[idx]!.iterations += 1;
      if (!it.success) buckets[idx]!.iterationFailures += 1;
    }
    for (const n of s.network) {
      const idx = indexFor(n.timestamp);
      if (idx === null) continue;
      buckets[idx]!.networkRequests += 1;
      if (isNetworkError(n)) buckets[idx]!.networkErrors += 1;
    }
  }
  if (input.perfStartOffsetsMs) {
    const offsets = input.perfStartOffsetsMs;
    const blockingByBucket: number[][] = buckets.map(() => []);
    for (const s of input.samples) {
      for (const p of s.perf ?? []) {
        const idx = indexFor(p.timestamp);
        if (idx !== null) blockingByBucket[idx]!.push(p.blockingMs);
      }
    }
    buckets.forEach((b, i) => {
      const bucketEnd = b.tMs + input.bucketMs;
      const blocking = perfQuantiles(blockingByBucket[i]!);
      b.perf = {
        // A worker whose offset is past the run never started (the runner
        // returns it empty), so it can never count here.
        startedWorkers: offsets.filter((o) => o < bucketEnd && o < input.durationMs).length,
        spans: blockingByBucket[i]!.length,
        blockingMsP50: blocking.p50,
        blockingMsP95: blocking.p95,
      };
    });
  }
  if (input.faultFirings) {
    for (const [name, firings] of Object.entries(input.faultFirings)) {
      for (const t of firings) {
        const idx = indexFor(t);
        if (idx === null) continue;
        buckets[idx]!.faults[name] = (buckets[idx]!.faults[name] ?? 0) + 1;
      }
    }
  }
  return buckets;
}

function isNetworkError(n: NetworkSample): boolean {
  return n.status === 0 || n.status >= 500;
}

/** Render a `LoadReport` as a compact ASCII summary for terminals / CI logs. */
export function formatLoadReport(report: LoadReport): string {
  const lines: string[] = [];
  lines.push(`Load run: ${report.baseUrl}`);
  lines.push(
    `  duration=${ms(report.durationMs)} workers=${report.config.workers} rampUp=${ms(report.config.rampUpMs)}`,
  );
  lines.push(
    `  iterations=${report.totals.iterations}${report.totals.truncatedIterations ? ` truncated=${report.totals.truncatedIterations}` : ""} failures=${report.totals.iterationFailures} stepFailures=${report.totals.stepFailures}`,
  );
  lines.push(
    `  network: ${report.totals.networkRequests} reqs / ${report.totals.networkErrors} errors`,
  );
  lines.push("");
  for (const s of report.scenarios) {
    lines.push(
      `Scenario: ${s.name}  workers=${s.workers} iter=${s.iterations} fail=${s.iterationFailures} throughput=${s.throughputPerSec.toFixed(2)}/s`,
    );
    for (const st of s.steps) {
      const l = st.latency;
      lines.push(
        `  ${st.name.padEnd(24)}  n=${pad(st.invocations, 5)}  err=${pad(st.failures, 4)}  p50=${ms(l.p50Ms)}  p95=${ms(l.p95Ms)}  p99=${ms(l.p99Ms)}`,
      );
      if (st.perf) lines.push(formatStepPerf(st.perf));
    }
    lines.push("");
  }
  if (report.endpoints.length > 0) {
    lines.push("Top endpoints:");
    for (const e of report.endpoints.slice(0, 10)) {
      const l = e.latency;
      lines.push(
        `  ${e.key.padEnd(40)}  n=${pad(e.count, 5)}  err=${pad(e.errorCount, 4)}  p50=${ms(l.p50Ms)}  p95=${ms(l.p95Ms)}  p99=${ms(l.p99Ms)}`,
      );
    }
  }
  if (report.timeline.length > 0) {
    lines.push("");
    lines.push(`Timeline (bucket=${ms(timelineBucketMs(report))}):`);
    lines.push(`  ${"iterations".padEnd(16)}${sparkline(report.timeline.map((b) => b.iterations))}`);
    lines.push(`  ${"errors".padEnd(16)}${sparkline(report.timeline.map((b) => b.iterationFailures + b.networkErrors))}`);
    const ruleNames = collectFaultRuleNames(report);
    for (const rule of ruleNames) {
      const series = report.timeline.map((b) => b.faults[rule] ?? 0);
      if (series.every((v) => v === 0)) continue;
      lines.push(`  ${("fault:" + rule).padEnd(16)}${sparkline(series)}`);
    }
    if (report.timeline.some((b) => b.perf)) {
      // Read against each other: blocking climbing with the worker count is
      // the browser-side cost of concurrency.
      lines.push(`  ${"workers".padEnd(16)}${sparkline(report.timeline.map((b) => b.perf?.startedWorkers ?? 0))}`);
      lines.push(`  ${"blocking p95".padEnd(16)}${sparkline(report.timeline.map((b) => b.perf?.blockingMsP95 ?? 0))}`);
    }
    const maxIter = Math.max(...report.timeline.map((b) => b.iterations));
    lines.push(`  peak: ${maxIter}/bucket`);
  }
  if (report.errors.length > 0) {
    lines.push("");
    lines.push("First errors:");
    for (const err of report.errors.slice(0, 5)) {
      lines.push(`  [${err.scenarioName}/${err.stepName}] ${err.message}`);
    }
    if (report.errors.length > 5) {
      lines.push(`  …and ${report.errors.length - 5} more`);
    }
  }
  return lines.join("\n");
}

function formatStepPerf(p: NonNullable<StepReport["perf"]>): string {
  const parts = [
    `browser n=${p.n}`,
    `dur p50=${ms(p.durationMs.p50)} p95=${ms(p.durationMs.p95)}`,
    `blocking p50=${ms(p.blockingMs.p50)} p95=${ms(p.blockingMs.p95)}`,
  ];
  if (p.interactionMs) {
    parts.push(`inp p50=${ms(p.interactionMs.p50)} p95=${ms(p.interactionMs.p95)} (n=${p.interactionMs.n})`);
  }
  return `  ${"".padEnd(24)}  ${parts.join("  ")}`;
}

function ms(n: number): string {
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width);
}

const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/**
 * Map an array of counts to a unicode sparkline. Empty / all-zero
 * input → an empty string. Scales linearly so 0 always maps to "▁"
 * and the max maps to "█".
 */
export function sparkline(values: ReadonlyArray<number>): string {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  if (max === 0) return SPARK_CHARS[0]!.repeat(values.length);
  const span = SPARK_CHARS.length - 1;
  return values
    .map((v) => {
      const idx = Math.round((v / max) * span);
      return SPARK_CHARS[idx]!;
    })
    .join("");
}

function collectFaultRuleNames(report: LoadReport): string[] {
  const seen = new Set<string>();
  for (const b of report.timeline) {
    for (const name of Object.keys(b.faults)) seen.add(name);
  }
  return [...seen].sort();
}

function timelineBucketMs(report: LoadReport): number {
  // Reverse-engineer bucket width from the timeline. Two-bucket runs
  // expose it directly; a single bucket means the whole run fit in
  // one window, so report the full run duration as the bucket.
  if (report.timeline.length >= 2) {
    return report.timeline[1]!.tMs - report.timeline[0]!.tMs;
  }
  return report.durationMs;
}
