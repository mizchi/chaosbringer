import { describe, expect, it } from "vitest";
import { buildLoadReport, formatLoadReport, sparkline } from "./report.js";
import type { Scenario, ScenarioSpec } from "./types.js";
import type { WorkerSamples } from "./worker.js";

const scenario: Scenario = {
  name: "checkout",
  steps: [
    { name: "open", run: async () => {} },
    { name: "buy", run: async () => {} },
  ],
};

const spec: ScenarioSpec = { scenario, workers: 2 };

const sampleFor = (worker: number, opts: { fails?: boolean } = {}): WorkerSamples => ({
  steps: [
    {
      scenarioName: scenario.name,
      stepName: "open",
      durationMs: 100 + worker * 10,
      success: true,
      iteration: 0,
      timestamp: 1000,
    },
    {
      scenarioName: scenario.name,
      stepName: "buy",
      durationMs: 200 + worker * 10,
      success: !opts.fails,
      iteration: 0,
      timestamp: 1100,
    },
  ],
  iterations: [
    {
      scenarioName: scenario.name,
      durationMs: 300,
      success: !opts.fails,
      iteration: 0,
      timestamp: 1200,
    },
  ],
  network: [
    {
      key: "/api/cart",
      url: "https://x/api/cart",
      status: 200,
      durationMs: 30,
      timestamp: 1100,
    },
    {
      key: "/api/checkout",
      url: "https://x/api/checkout",
      status: opts.fails ? 500 : 200,
      durationMs: opts.fails ? 800 : 80,
      timestamp: 1150,
    },
  ],
  errors: opts.fails
    ? [
        {
          scenarioName: scenario.name,
          stepName: "buy",
          iteration: 0,
          timestamp: 1180,
          message: "boom",
        },
      ]
    : [],
});

describe("buildLoadReport", () => {
  it("aggregates iterations, step latencies, and endpoints across workers", () => {
    const report = buildLoadReport({
      baseUrl: "https://x",
      startTime: 1000,
      endTime: 11000,
      durationMs: 10000,
      plannedDurationMs: 10000,
      rampUpMs: 0,
      planned: [
        { workerIndex: 0, spec },
        { workerIndex: 1, spec },
      ],
      samples: [sampleFor(0), sampleFor(1, { fails: true })],
    });

    expect(report.scenarios.length).toBe(1);
    const sc = report.scenarios[0]!;
    expect(sc.iterations).toBe(2);
    expect(sc.iterationFailures).toBe(1);
    expect(sc.throughputPerSec).toBeCloseTo(0.2);
    expect(sc.steps.map((s) => s.name).sort()).toEqual(["buy", "open"]);

    const buy = sc.steps.find((s) => s.name === "buy")!;
    expect(buy.invocations).toBe(2);
    expect(buy.failures).toBe(1);
    expect(buy.errorRate).toBeCloseTo(0.5);

    expect(report.endpoints.length).toBe(2);
    const checkout = report.endpoints.find((e) => e.key === "/api/checkout")!;
    expect(checkout.count).toBe(2);
    expect(checkout.errorCount).toBe(1);

    expect(report.totals.iterations).toBe(2);
    expect(report.totals.iterationFailures).toBe(1);
    expect(report.totals.networkErrors).toBe(1);

    expect(report.errors.length).toBe(1);
    expect(report.errors[0]!.message).toBe("boom");

    expect(report.workers.length).toBe(2);
    expect(report.workers[0]!.iterations).toBe(1);
    expect(report.workers[1]!.iterationFailures).toBe(1);
  });

  it("produces a per-second timeline aligned to start time", () => {
    const start = 10_000;
    const sample: WorkerSamples = {
      steps: [],
      iterations: [
        { scenarioName: "x", durationMs: 100, success: true, iteration: 0, timestamp: start + 500 },
        { scenarioName: "x", durationMs: 100, success: true, iteration: 1, timestamp: start + 1500 },
        { scenarioName: "x", durationMs: 100, success: false, iteration: 2, timestamp: start + 1700 },
        { scenarioName: "x", durationMs: 100, success: true, iteration: 3, timestamp: start + 4500 },
        // Out-of-window — should be dropped.
        { scenarioName: "x", durationMs: 100, success: true, iteration: 4, timestamp: start + 9999 },
      ],
      network: [
        { key: "/x", url: "https://x/x", status: 500, durationMs: 10, timestamp: start + 1200 },
      ],
      errors: [],
    };
    const report = buildLoadReport({
      baseUrl: "https://x",
      startTime: start,
      endTime: start + 5000,
      durationMs: 5000,
      plannedDurationMs: 5000,
      rampUpMs: 0,
      planned: [{ workerIndex: 0, spec: { scenario, workers: 1 } }],
      samples: [sample],
    });
    expect(report.timeline.length).toBe(5);
    expect(report.timeline[0]!.iterations).toBe(1);
    expect(report.timeline[1]!.iterations).toBe(2);
    expect(report.timeline[1]!.iterationFailures).toBe(1);
    expect(report.timeline[1]!.networkRequests).toBe(1);
    expect(report.timeline[1]!.networkErrors).toBe(1);
    expect(report.timeline[2]!.iterations).toBe(0);
    expect(report.timeline[4]!.iterations).toBe(1);
  });

  it("respects a custom bucket width", () => {
    const start = 10_000;
    const report = buildLoadReport({
      baseUrl: "https://x",
      startTime: start,
      endTime: start + 2000,
      durationMs: 2000,
      plannedDurationMs: 2000,
      rampUpMs: 0,
      planned: [{ workerIndex: 0, spec: { scenario, workers: 1 } }],
      samples: [{ steps: [], iterations: [], network: [], errors: [] }],
      timelineBucketMs: 500,
    });
    expect(report.timeline.length).toBe(4);
    expect(report.timeline.map((b) => b.tMs)).toEqual([0, 500, 1000, 1500]);
  });

  it("disables the timeline when bucketMs <= 0", () => {
    const report = buildLoadReport({
      baseUrl: "https://x",
      startTime: 0,
      endTime: 1000,
      durationMs: 1000,
      plannedDurationMs: 1000,
      rampUpMs: 0,
      planned: [{ workerIndex: 0, spec: { scenario, workers: 1 } }],
      samples: [{ steps: [], iterations: [], network: [], errors: [] }],
      timelineBucketMs: 0,
    });
    expect(report.timeline).toEqual([]);
  });

  it("renders a non-empty ASCII summary", () => {
    const report = buildLoadReport({
      baseUrl: "https://x",
      startTime: 1000,
      endTime: 11000,
      durationMs: 10000,
      plannedDurationMs: 10000,
      rampUpMs: 0,
      planned: [{ workerIndex: 0, spec }],
      samples: [sampleFor(0)],
    });
    const text = formatLoadReport(report);
    expect(text).toContain("Load run: https://x");
    expect(text).toContain("Scenario: checkout");
    expect(text).toContain("Top endpoints:");
    expect(text).toContain("Timeline (bucket=");
  });
});

describe("sparkline", () => {
  it("returns '' for empty input", () => {
    expect(sparkline([])).toBe("");
  });

  it("returns the lowest character when all zero", () => {
    expect(sparkline([0, 0, 0])).toBe("▁▁▁");
  });

  it("scales linearly so max → █ and 0 → ▁", () => {
    const s = sparkline([0, 5, 10]);
    expect(s.length).toBe(3);
    expect(s[0]).toBe("▁");
    expect(s[s.length - 1]).toBe("█");
  });
});
