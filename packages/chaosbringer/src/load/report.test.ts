import { describe, expect, it } from "vitest";
import { buildLoadReport, formatLoadReport } from "./report.js";
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
  });
});
