import { describe, expect, it } from "vitest";
import { EMIT_META_KEY, emitSlugBudgets, flagValues, floorsFromArgv, slugBudgets, type SlugBudgetsFile } from "./cli-budgets";
import type { SpanReport } from "./report-types";
import { DEFAULT_BUDGET_FLOORS, gate, spanMedians } from "./stats";

// Minimal SpanReport: only what spanMedians reads.
function span(name: string, scriptMs: number, requestCount: number): SpanReport {
  return {
    name,
    durationMs: 100,
    network: { busyMs: 0, waves: 0, encodedKB: 0, requestCount },
    cpu: { blockingMs: 0, maxLongTaskMs: 0 },
    render: { recalcStyleCount: 0, recalcStyleMs: 0, layoutCount: 0, layoutMs: 0, nodes: 0, scriptMs },
  } as unknown as SpanReport;
}

describe("floorsFromArgv (lightbringer run --floor)", () => {
  it("reads every --floor, in both spellings, over the defaults", () => {
    const argv = ["run", "s.json", "--emit-budgets", "--floor", "scriptMs=12", "--repeat", "3", "--floor=requestCount=0"];
    expect(flagValues(argv, "floor")).toEqual(["scriptMs=12", "requestCount=0"]);
    expect(floorsFromArgv(argv)).toEqual({ ...DEFAULT_BUDGET_FLOORS, scriptMs: 12, requestCount: 0 });
    expect(floorsFromArgv(["run", "s.json", "--emit-budgets"])).toEqual(DEFAULT_BUDGET_FLOORS);
  });

  it.each([
    [["--floor"], "--floor needs a value"],
    [["--floor", "--gate"], "--floor needs a value"],
    [["--floor", "scriptMs"], '--floor "scriptMs": expected <metric>=<n>'],
    [["--floor=bogusMs=3"], '--floor "bogusMs=3": unknown metric "bogusMs"'],
    [["--floor", "scriptMs=-2"], '--floor "scriptMs=-2": n must be a number >= 0'],
    [["--floor", "scriptMs=5ms"], '--floor "scriptMs=5ms": n must be a number >= 0'],
  ])("refuses %j", (flags, message) => {
    expect(() => floorsFromArgv(["run", "s.json", "--emit-budgets", ...flags])).toThrow(message);
  });
});

describe("lightbringer.budgets.json", () => {
  const runs = [1, 2, 3].map((i) => ({ spans: [span("open", 2 + i, 0)] }));

  it("records the headroom and floors next to the budgets, which use them", () => {
    const floors = { ...DEFAULT_BUDGET_FLOORS, requestCount: 0 };
    const file = emitSlugBudgets(new Map([["cart", runs]]), { floors });
    expect(file[EMIT_META_KEY]).toEqual({ headroom: 1.25, floors });
    // scriptMs median 4 → 4 + 8; requestCount 0 with its floor off → 0.
    expect(slugBudgets(file, "cart").open).toMatchObject({ scriptMs: 12, requestCount: 0 });
    // A JSON round trip keeps both.
    const read = JSON.parse(JSON.stringify(file)) as SlugBudgetsFile;
    expect(read[EMIT_META_KEY]).toEqual({ headroom: 1.25, floors });
    expect(gate(spanMedians(runs), slugBudgets(read, "cart")).violations).toEqual([]);
  });

  it("still gates on a file written before floors were recorded", () => {
    const old = { cart: { open: { scriptMs: 5, requestCount: 0 } } } as SlugBudgetsFile;
    expect(slugBudgets(old, "cart")).toEqual({ open: { scriptMs: 5, requestCount: 0 } });
    expect(slugBudgets(old, "other")).toEqual({});
    const slow = [{ spans: [span("open", 40, 0)] }];
    expect(gate(spanMedians(slow), slugBudgets(old, "cart")).violations).toEqual([
      { scope: "open", metric: "scriptMs", median: 40, limit: 5 },
    ]);
  });

  it("never reads $emit as a slug's budgets", () => {
    const file = emitSlugBudgets(new Map([["cart", runs]]));
    expect(slugBudgets(file, EMIT_META_KEY)).toEqual({});
  });
});
