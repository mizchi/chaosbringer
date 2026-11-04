import { describe, expect, it } from "vitest";
import {
  aggregateRuns,
  checkMedianBudgets,
  DEFAULT_BUDGET_FLOORS,
  EMIT_BUDGET_METRICS,
  emitBudgets,
  parseBudgetFloors,
  formatMedianSummary,
  formatStat,
  gate,
  median,
  percentile,
  spanMedians,
  stat,
  type RunReport,
} from "./stats";
import type { SpanReport } from "./report-types";

// Minimal SpanReport: only what the aggregates read.
function span(name: string, over: Partial<Record<string, unknown>> = {}): SpanReport {
  return {
    name,
    durationMs: 100,
    capped: false,
    network: { busyMs: 10, waves: 1, encodedKB: 5, requestCount: 2 },
    cpu: { blockingMs: 0, maxLongTaskMs: 0 },
    render: {
      recalcStyleCount: 1,
      recalcStyleMs: 1,
      layoutCount: 1,
      layoutMs: 1,
      nodes: 10,
      scriptMs: 3,
    },
    traceWindowUs: [0, 0],
    ...over,
  } as unknown as SpanReport;
}

const run = (spans: SpanReport[], vitals: Record<string, number> = {}): RunReport =>
  ({
    vitals: Object.fromEntries(Object.entries(vitals).map(([k, value]) => [k, { value }])),
    spans,
  }) as unknown as RunReport;

describe("percentile (nearest rank)", () => {
  it("rounds the rank half up, as Math.round does", () => {
    // 3 values: p25 → rank round(0.5)=1, p75 → rank round(1.5)=2
    expect(percentile([1, 2, 3], 0.25)).toBe(2);
    expect(percentile([1, 2, 3], 0.75)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(percentile([], 0.5)).toBe(0);
  });
});

describe("median", () => {
  it("takes the middle value, or the mean of the middle two, rounded to 0.1", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([1.04, 1.06])).toBe(1.1);
    expect(median([])).toBe(0);
  });
  it("does not reorder its input", () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe("stat", () => {
  it("reports the IQR band and min..max, rounded", () => {
    expect(stat([10, 20, 30, 40, 50])).toEqual({
      median: 30,
      p25: 20,
      p75: 40,
      min: 10,
      max: 50,
      noisy: true, // (40-20)/30 > 0.25
      n: 5,
    });
  });
  it("flags noisy only above a 25% relative IQR", () => {
    // IQR 25 on a median of 100: exactly 25%, not noisy
    expect(stat([75, 100, 100, 100, 100]).noisy).toBe(false);
    expect(stat([70, 100, 100, 100, 100]).p25).toBe(100);
    expect(stat([70, 75, 100, 101, 110]).noisy).toBe(true);
  });
  it("never flags a median of 5 or less", () => {
    expect(stat([0, 5, 50]).noisy).toBe(false);
    expect(stat([0, 5.1, 50]).noisy).toBe(true);
  });
  it("formats as median (p25..p75) with a noisy marker", () => {
    expect(formatStat(stat([1, 2, 3]))).toBe("2 (2..3)");
    expect(formatStat(stat([10, 20, 30, 40, 50]))).toBe("30 (20..40) !noisy");
  });
});

describe("aggregateRuns", () => {
  it("matches spans by name in first-seen order and aggregates vitals", () => {
    const agg = aggregateRuns("s", [
      run([span("a", { durationMs: 10 }), span("b")], { LCP: 100 }),
      run([span("c"), span("a", { durationMs: 30 })], { LCP: 300, CLS: 0.1 }),
    ]);
    expect(agg.runs).toBe(2);
    expect(agg.spans.map((s) => s.name)).toEqual(["a", "b", "c"]);
    expect(agg.spans[0]!.durationMs.median).toBe(20);
    expect(agg.vitals.LCP!.median).toBe(200);
    expect(agg.vitals.CLS!.n).toBe(1);
  });

  it("leaves unmeasured groups out and counts a missing field as 0", () => {
    const agg = aggregateRuns("s", [
      run([span("a")]),
      run([span("a", { interaction: { maxDurationMs: 40, inputDelayMs: 1, processingMs: 2, presentationMs: 3 } })]),
    ]);
    const a = agg.spans[0]!;
    expect(a.memory).toBeUndefined();
    expect(a.frames).toBeUndefined();
    expect(a.render.paintCount).toBeUndefined();
    // one run had no interaction: its sample is 0
    expect(a.interaction!.maxDurationMs).toMatchObject({ median: 20, min: 0, max: 40 });
    // thirdParty absent: 0
    expect(a.network.thirdPartyKB.median).toBe(0);
  });

  it("keeps the historical key order of <slug>.median.json", () => {
    const agg = aggregateRuns("s", [run([span("a", { budget: { durationMs: 1 } })])]);
    expect(Object.keys(agg)).toEqual(["slug", "runs", "vitals", "vitalsBudget", "spans", "appSpans"]);
    expect(Object.keys(agg.spans[0]!)).toEqual([
      "name",
      "durationMs",
      "network",
      "cpu",
      "render",
      "memory",
      "interaction",
      "frames",
      "budget",
    ]);
  });

  it("summarises app spans across runs", () => {
    const app = (d: number) => ({ name: "fetch", durationMs: d, network: { busyMs: 1 }, cpu: { blockingMs: 0 } });
    const agg = aggregateRuns("s", [
      { ...run([]), appSpans: [app(1), app(3)] } as unknown as RunReport,
      { ...run([]), appSpans: [app(5)] } as unknown as RunReport,
    ]);
    expect(agg.appSpans[0]).toMatchObject({ name: "fetch", occurrences: 3 });
    expect(agg.appSpans[0]!.durationMs.median).toBe(3);
  });
});

describe("formatMedianSummary", () => {
  it("prints vitals, each span's lines and the net-saturated hint", () => {
    const agg = aggregateRuns("slug", [
      run([span("load", { durationMs: 100, network: { busyMs: 95, waves: 1, encodedKB: 5, requestCount: 2 } })]),
    ]);
    const text = formatMedianSummary(agg);
    expect(text.split("\n").slice(0, 4)).toEqual([
      "",
      "[median] slug  (1 runs)",
      "  vitals  LCP=n/a  INP=n/a  CLS=n/a  TTFB=n/a",
      "  load  100 (100..100)ms",
    ]);
    expect(text).toContain("(net-saturated: busyMs ≈ window)");
  });
});

describe("gate", () => {
  it("fails a median above budget and warns when a noisy p75 straddles it", () => {
    const r = gate(
      { a: { x: stat([10, 20, 30, 40, 50]), y: stat([10, 20, 30, 40, 50]), z: 1 } },
      { a: { x: 25, y: 35, z: 2, missing: 1, nul: null } },
    );
    expect(r.violations).toEqual([{ scope: "a", metric: "x", median: 30, limit: 25 }]);
    expect(r.warnings).toEqual([{ scope: "a", metric: "y", median: 30, limit: 35, p75: 40 }]);
  });
  it("gates bare medians without warnings", () => {
    expect(gate({ a: { x: 3 } }, { a: { x: 2 } }).violations).toHaveLength(1);
    expect(gate({ a: { x: 2 } }, { a: { x: 2 } })).toEqual({ violations: [], warnings: [] });
  });
});

describe("checkMedianBudgets", () => {
  it("prints the median.mjs lines: span warnings carry the 'add runs' hint, vitals do not", () => {
    const runs = [10, 20, 30, 40, 50].map((d) =>
      ({
        ...run([span("s", { durationMs: d, budget: { durationMs: 35, scriptMs: 1, paintMs: 1 } })], {
          LCP: d,
        }),
        vitalsBudget: { LCP: 35, CLS: 1 },
      }) as RunReport,
    );
    const r = checkMedianBudgets(aggregateRuns("slug", runs));
    expect(r.violations).toEqual(["slug / s.scriptMs median=3 > budget 1"]);
    expect(r.warnings).toEqual([
      "slug / s.durationMs median=30 <= 35 but noisy (p75=40) — gate may be flaky, add runs",
      "slug / vitals.LCP median=30 <= 35 but noisy (p75=40)",
    ]);
  });
});

describe("spanMedians / emitBudgets", () => {
  it("medians the eight CLI metrics, skipping unmeasured ones", () => {
    const m = spanMedians([
      { spans: [span("a", { durationMs: 10 })] },
      { spans: [span("a", { durationMs: 21 })] },
    ]);
    expect(m).toEqual({
      a: {
        durationMs: 15.5,
        scriptMs: 3,
        blockingMs: 0,
        layoutCount: 1,
        recalcStyleMs: 1,
        encodedKB: 5,
        requestCount: 2,
      },
    });
  });
  it("emits ceil(median × 1.25) for a metric with no floor", () => {
    expect(emitBudgets({ a: { x: 15.5, y: 0, z: 4 } })).toEqual({ a: { x: 20, y: 0, z: 5 } });
    expect(emitBudgets({ a: { x: 10, y: 10 } }, { headroom: 2, metrics: ["x"] })).toEqual({ a: { x: 20 } });
  });
  it("gives a median of 0 its floor, so a same-seed rerun has room for scheduler noise", () => {
    expect(emitBudgets({ a: { scriptMs: 0, blockingMs: 0, requestCount: 0, interactionMs: 0 } })).toEqual({
      a: { scriptMs: 8, blockingMs: 5, requestCount: 1, interactionMs: 16 },
    });
  });
  it("adds the floor to a small median and keeps the headroom rule for a large one", () => {
    // 4 ms × 1.25 = 5 (1 ms of slack) → 4 + 8 = 12; 1.1 + 7 = 8.1 → 9.
    expect(emitBudgets({ a: { scriptMs: 4, recalcStyleMs: 1.1, layoutCount: 3 } })).toEqual({
      a: { scriptMs: 12, recalcStyleMs: 9, layoutCount: 5 },
    });
    // 400 × 1.25 = 500 > 400 + 8: the floor changes nothing.
    expect(emitBudgets({ a: { scriptMs: 400, encodedKB: 800, requestCount: 40 } })).toEqual({
      a: { scriptMs: 500, encodedKB: 1000, requestCount: 50 },
    });
  });
  it("takes caller floors over the defaults; a floor of 0 turns it off", () => {
    const floors = { ...DEFAULT_BUDGET_FLOORS, scriptMs: 20, requestCount: 0 };
    expect(emitBudgets({ a: { scriptMs: 4, requestCount: 0, blockingMs: 0 } }, { floors })).toEqual({
      a: { scriptMs: 24, requestCount: 0, blockingMs: 5 },
    });
    // A partial table means "only these floors": the others are 0.
    expect(emitBudgets({ a: { scriptMs: 4, blockingMs: 0 } }, { floors: { scriptMs: 1 } })).toEqual({
      a: { scriptMs: 5, blockingMs: 0 },
    });
  });
  it("has a default floor for every metric it emits", () => {
    expect(Object.keys(DEFAULT_BUDGET_FLOORS).sort()).toEqual(Object.keys(EMIT_BUDGET_METRICS).sort());
    for (const v of Object.values(DEFAULT_BUDGET_FLOORS)) expect(v).toBeGreaterThanOrEqual(0);
  });
});

describe("parseBudgetFloors (--floor metric=n)", () => {
  it("overrides the named floors over the defaults, the last one winning", () => {
    expect(parseBudgetFloors([])).toEqual(DEFAULT_BUDGET_FLOORS);
    expect(parseBudgetFloors(["scriptMs=12", "requestCount=0", "scriptMs=8.5"])).toEqual({
      ...DEFAULT_BUDGET_FLOORS,
      scriptMs: 8.5,
      requestCount: 0,
    });
  });
  it.each([
    ["scriptMs", '--floor "scriptMs": expected <metric>=<n>'],
    ["=5", '--floor "=5": expected <metric>=<n>'],
    ["scriptMS=5", '--floor "scriptMS=5": unknown metric "scriptMS" (expected one of durationMs, scriptMs, blockingMs, layoutCount, recalcStyleMs, encodedKB, requestCount, interactionMs)'],
    ["scriptMs=-1", '--floor "scriptMs=-1": n must be a number >= 0'],
    ["scriptMs=abc", '--floor "scriptMs=abc": n must be a number >= 0'],
    // Number("") is 0: `--floor "scriptMs=$F"` with F unset must not turn the floor off.
    ["scriptMs=", '--floor "scriptMs=": n must be a number >= 0'],
    ["scriptMs=Infinity", '--floor "scriptMs=Infinity": n must be a number >= 0'],
  ])("refuses %j", (raw, message) => {
    expect(() => parseBudgetFloors([raw])).toThrow(message);
  });
});
