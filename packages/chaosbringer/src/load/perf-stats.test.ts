import { describe, expect, it } from "vitest";
import { emptyLatencyStats } from "./histogram.js";
import {
  perfQuantiles,
  resolveLoadPerf,
  sampledWorkerIndexes,
  stepPerfStats,
  type WorkerPerfSample,
} from "./perf-stats.js";
import { buildLoadReport, formatLoadReport } from "./report.js";
import { evaluateSlo } from "./slo.js";
import type { LoadReport, Scenario, ScenarioSpec } from "./types.js";
import type { WorkerSamples } from "./worker.js";

const perf = (
  stepName: string,
  timestamp: number,
  blockingMs: number,
  extra: Partial<WorkerPerfSample> = {},
): WorkerPerfSample => ({
  scenarioName: "shop",
  stepName,
  timestamp,
  durationMs: 100,
  blockingMs,
  ...extra,
});

describe("resolveLoadPerf", () => {
  it("is off for undefined / false and light with one sampled worker for true", () => {
    expect(resolveLoadPerf(undefined)).toBeNull();
    expect(resolveLoadPerf(false)).toBeNull();
    expect(resolveLoadPerf(true)).toEqual({ level: "light", sampleWorkers: 1 });
    expect(resolveLoadPerf({ sampleWorkers: 3 })).toEqual({ level: "light", sampleWorkers: 3 });
  });

  it("rejects trace level and non-positive-integer sampleWorkers", () => {
    expect(() => resolveLoadPerf({ level: "trace" } as never)).toThrow(/only "light"/);
    expect(() => resolveLoadPerf({ sampleWorkers: 0 })).toThrow(/positive integer/);
    expect(() => resolveLoadPerf({ sampleWorkers: 1.5 })).toThrow(/positive integer/);
  });
});

describe("sampledWorkerIndexes", () => {
  it("takes the first N workers of each spec, capped at the spec's size", () => {
    const a = {};
    const b = {};
    const planned = [
      { workerIndex: 0, spec: a },
      { workerIndex: 1, spec: a },
      { workerIndex: 2, spec: a },
      { workerIndex: 3, spec: b },
    ];
    expect([...sampledWorkerIndexes(planned, 1)]).toEqual([0, 3]);
    expect([...sampledWorkerIndexes(planned, 2)]).toEqual([0, 1, 3]);
  });
});

describe("stepPerfStats", () => {
  it("is undefined with no samples", () => {
    expect(stepPerfStats([])).toBeUndefined();
    expect(perfQuantiles([])).toEqual({ p50: 0, p95: 0 });
  });

  it("gives p50/p95 of duration and blocking, and interaction over spans that had one", () => {
    const samples = [0, 10, 20, 30, 40].map((b, i) =>
      perf("buy", i, b, { durationMs: 100 + b, ...(i < 2 ? { interactionMs: 50 + i * 100 } : {}) }),
    );
    const s = stepPerfStats(samples)!;
    expect(s.n).toBe(5);
    expect(s.blockingMs.p50).toBe(20);
    expect(s.blockingMs.p95).toBeCloseTo(38);
    expect(s.durationMs.p50).toBe(120);
    expect(s.interactionMs).toEqual({ n: 2, p50: 100, p95: 145 });
  });

  it("omits interactionMs when no span had one", () => {
    expect(stepPerfStats([perf("open", 0, 5)])!.interactionMs).toBeUndefined();
  });
});

const scenario: Scenario = {
  name: "shop",
  steps: [
    { name: "open", run: async () => {} },
    { name: "buy", run: async () => {} },
  ],
};
const spec: ScenarioSpec = { scenario, workers: 2 };

const samples = (p: WorkerPerfSample[] | undefined): WorkerSamples => ({
  steps: [
    { scenarioName: "shop", stepName: "open", durationMs: 50, success: true, iteration: 0, timestamp: 100 },
    { scenarioName: "shop", stepName: "buy", durationMs: 80, success: true, iteration: 0, timestamp: 1500 },
  ],
  iterations: [],
  network: [],
  errors: [],
  runtimeFaultStats: {},
  ...(p ? { perf: p } : {}),
});

function reportWithPerf(): LoadReport {
  return buildLoadReport({
    baseUrl: "https://x",
    startTime: 0,
    endTime: 2000,
    durationMs: 2000,
    plannedDurationMs: 2000,
    rampUpMs: 1000,
    planned: [
      { workerIndex: 0, spec, startOffsetMs: 0 },
      { workerIndex: 1, spec, startOffsetMs: 1000 },
    ],
    // Worker 0 is sampled; worker 1 ran unmeasured.
    samples: [
      samples([perf("open", 100, 0), perf("buy", 1500, 120, { interactionMs: 140 }), perf("buy", 1600, 60)]),
      samples(undefined),
    ],
    timelineBucketMs: 1000,
    perf: { level: "light", sampledWorkers: 1 },
  });
}

describe("buildLoadReport with perf", () => {
  it("attaches per-step browser stats from the sampled workers only", () => {
    const r = reportWithPerf();
    expect(r.config.perf).toEqual({ level: "light", sampledWorkers: 1 });
    const [open, buy] = r.scenarios[0]!.steps;
    // Wall-clock latency still counts every worker's executions.
    expect(buy!.invocations).toBe(2);
    expect(open!.perf).toEqual({ n: 1, durationMs: { p50: 100, p95: 100 }, blockingMs: { p50: 0, p95: 0 } });
    expect(buy!.perf!.n).toBe(2);
    expect(buy!.perf!.blockingMs.p50).toBe(90);
    expect(buy!.perf!.interactionMs).toEqual({ n: 1, p50: 140, p95: 140 });
  });

  it("buckets blocking by span end, with the workers started by each bucket's end", () => {
    const r = reportWithPerf();
    expect(r.timeline.map((b) => b.perf)).toEqual([
      { startedWorkers: 1, spans: 1, blockingMsP50: 0, blockingMsP95: 0 },
      { startedWorkers: 2, spans: 2, blockingMsP50: 90, blockingMsP95: 117 },
    ]);
    const text = formatLoadReport(r);
    expect(text).toContain("browser n=2");
    expect(text).toContain("inp p50=140ms");
    expect(text).toContain("blocking p95");
  });

  it("leaves the report shape unchanged with perf off", () => {
    const r = buildLoadReport({
      baseUrl: "https://x",
      startTime: 0,
      endTime: 1000,
      durationMs: 1000,
      plannedDurationMs: 1000,
      rampUpMs: 0,
      planned: [{ workerIndex: 0, spec }],
      samples: [samples(undefined)],
    });
    expect(r.config.perf).toBeUndefined();
    expect(r.scenarios[0]!.steps.every((s) => s.perf === undefined)).toBe(true);
    expect(r.timeline.every((b) => b.perf === undefined)).toBe(true);
    expect(formatLoadReport(r)).not.toContain("browser n=");
  });
});

describe("step perf SLOs", () => {
  it("passes within bounds and names the breached perf metric", () => {
    const r = reportWithPerf();
    expect(evaluateSlo(r, { steps: { "shop/buy": { perf: { blockingMsP95: 200 } } } }).ok).toBe(true);
    const res = evaluateSlo(r, { steps: { "shop/buy": { perf: { blockingMsP50: 50, interactionMsP95: 500 } } } });
    expect(res.violations).toHaveLength(1);
    expect(res.violations[0]).toMatchObject({ metric: "perf.blockingMsP50", threshold: 50, actual: 90 });
  });

  it("treats an unmeasured step or interaction as a violation", () => {
    const r = reportWithPerf();
    const noInteraction = evaluateSlo(r, { steps: { "shop/open": { perf: { interactionMsP95: 200 } } } });
    expect(noInteraction.violations[0]).toMatchObject({ metric: "perf.interactionMsP95", actual: null });
    expect(noInteraction.violations[0]!.message).toMatch(/no span of the step had an interaction/);

    r.scenarios[0]!.steps[0] = {
      name: "open",
      invocations: 1,
      failures: 0,
      errorRate: 0,
      latency: emptyLatencyStats(),
    };
    const unmeasured = evaluateSlo(r, { steps: { "shop/open": { perf: { blockingMsP95: 10 } } } });
    expect(unmeasured.violations[0]).toMatchObject({ metric: "perf.blockingMsP95", actual: null });
    expect(unmeasured.violations[0]!.message).toMatch(/perf off/);
  });
});
