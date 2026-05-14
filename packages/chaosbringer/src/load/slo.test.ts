import { describe, expect, it } from "vitest";
import { emptyLatencyStats } from "./histogram.js";
import { assertSlo, evaluateSlo } from "./slo.js";
import type { LoadReport } from "./types.js";

function makeReport(): LoadReport {
  return {
    baseUrl: "https://x",
    startTime: 0,
    endTime: 10_000,
    durationMs: 10_000,
    config: { workers: 2, rampUpMs: 0, durationMs: 10_000 },
    totals: {
      iterations: 20,
      iterationFailures: 2,
      stepFailures: 3,
      networkRequests: 100,
      networkErrors: 5,
    },
    scenarios: [
      {
        name: "shop",
        workers: 2,
        iterations: 20,
        iterationFailures: 2,
        throughputPerSec: 2,
        steps: [
          {
            name: "open",
            invocations: 20,
            failures: 0,
            errorRate: 0,
            latency: { ...emptyLatencyStats(), p50Ms: 50, p95Ms: 100, p99Ms: 120, meanMs: 60, count: 20 },
          },
          {
            name: "checkout",
            invocations: 18,
            failures: 3,
            errorRate: 3 / 18,
            latency: { ...emptyLatencyStats(), p50Ms: 150, p95Ms: 300, p99Ms: 400, meanMs: 180, count: 18 },
          },
        ],
      },
    ],
    workers: [],
    endpoints: [
      {
        key: "/api/checkout",
        count: 18,
        errorCount: 3,
        status: { "200": 15, "500": 3 },
        latency: { ...emptyLatencyStats(), p50Ms: 80, p95Ms: 200, p99Ms: 250, meanMs: 100, count: 18 },
      },
    ],
    timeline: [],
    errors: [],
  };
}

describe("evaluateSlo", () => {
  it("returns ok when no thresholds are set", () => {
    const r = evaluateSlo(makeReport(), {});
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("returns ok when every threshold is met", () => {
    const r = evaluateSlo(makeReport(), {
      steps: {
        "shop/open": { p95Ms: 200, errorRate: 0.01 },
        "shop/checkout": { p99Ms: 500, errorRate: 0.2 },
      },
      scenarios: { shop: { errorRate: 0.5, minThroughputPerSec: 1 } },
      endpoints: { "/api/checkout": { p95Ms: 300, errorRate: 0.2 } },
      totals: { maxIterationFailures: 5, maxNetworkErrors: 10 },
    });
    expect(r.ok).toBe(true);
  });

  it("reports step latency violations", () => {
    const r = evaluateSlo(makeReport(), {
      steps: { "shop/checkout": { p95Ms: 100 } },
    });
    expect(r.ok).toBe(false);
    expect(r.violations.length).toBe(1);
    expect(r.violations[0]!.scope).toBe("step");
    expect(r.violations[0]!.target).toBe("shop/checkout");
    expect(r.violations[0]!.metric).toBe("p95Ms");
    expect(r.violations[0]!.threshold).toBe(100);
    expect(r.violations[0]!.actual).toBe(300);
    expect(r.violations[0]!.message).toMatch(/p95Ms=300 exceeds 100/);
  });

  it("reports scenario throughput min-violations as 'below'", () => {
    const r = evaluateSlo(makeReport(), {
      scenarios: { shop: { minThroughputPerSec: 5 } },
    });
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.message).toMatch(/below 5/);
  });

  it("reports missing targets as violations", () => {
    const r = evaluateSlo(makeReport(), {
      steps: { "shop/buy": { p95Ms: 100 } },
      endpoints: { "/api/missing": { p95Ms: 50 } },
    });
    expect(r.ok).toBe(false);
    expect(r.violations.length).toBe(2);
    for (const v of r.violations) {
      expect(v.metric).toBe("<missing>");
      expect(v.actual).toBeNull();
    }
  });

  it("reports totals violations", () => {
    const r = evaluateSlo(makeReport(), {
      totals: { maxIterationFailures: 0, maxNetworkErrors: 1 },
    });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.metric).sort()).toEqual(["maxIterationFailures", "maxNetworkErrors"]);
  });

  it("aggregates multiple violations", () => {
    const r = evaluateSlo(makeReport(), {
      steps: {
        "shop/open": { p95Ms: 10 },     // fails
        "shop/checkout": { p99Ms: 100 }, // fails
      },
      totals: { maxNetworkErrors: 0 },  // fails
    });
    expect(r.violations.length).toBe(3);
  });
});

describe("assertSlo", () => {
  it("does not throw when ok", () => {
    expect(() => assertSlo(makeReport(), { totals: { maxIterationFailures: 100 } })).not.toThrow();
  });

  it("throws with structured violations on failure", () => {
    try {
      assertSlo(makeReport(), { totals: { maxNetworkErrors: 0 } });
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as Error & { violations?: unknown[] };
      expect(e.message).toMatch(/SLO failed/);
      expect(e.violations).toBeDefined();
      expect(Array.isArray(e.violations)).toBe(true);
      expect(e.violations!.length).toBe(1);
    }
  });
});
