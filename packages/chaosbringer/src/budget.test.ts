import { describe, expect, it } from "vitest";
import { checkPerformanceBudget } from "./budget.js";

describe("checkPerformanceBudget", () => {
  it("returns no violations when budget is undefined", () => {
    expect(checkPerformanceBudget({ ttfb: 5000 }, undefined, "http://x/")).toEqual([]);
  });

  it("returns no violations when every metric is within limit", () => {
    const out = checkPerformanceBudget(
      { ttfb: 100, fcp: 500, lcp: 1000 },
      { ttfb: 200, fcp: 1800, lcp: 2500 },
      "http://x/"
    );
    expect(out).toEqual([]);
  });

  it("flags each breached metric as a separate invariant-violation", () => {
    const out = checkPerformanceBudget(
      { ttfb: 500, fcp: 2000, lcp: 3000 },
      { ttfb: 200, fcp: 1800, lcp: 2500 },
      "http://x/"
    );
    expect(out).toHaveLength(3);
    const names = out.map((e) => e.invariantName).sort();
    expect(names).toEqual(["perf-budget.fcp", "perf-budget.lcp", "perf-budget.ttfb"]);
    for (const e of out) {
      expect(e.type).toBe("invariant-violation");
      expect(e.url).toBe("http://x/");
    }
  });

  it("treats equality as within budget (<=, not <)", () => {
    const out = checkPerformanceBudget({ ttfb: 200 }, { ttfb: 200 }, "http://x/");
    expect(out).toEqual([]);
  });

  it("ignores metrics that were not measured", () => {
    // lcp wasn't captured; the budget on it should not produce a violation.
    const out = checkPerformanceBudget(
      { ttfb: 100 },
      { ttfb: 200, lcp: 1000 },
      "http://x/"
    );
    expect(out).toEqual([]);
  });

  it("ignores budget entries with non-numeric limits defensively", () => {
    const out = checkPerformanceBudget(
      { ttfb: 5000 },
      // biome-ignore lint: testing defensive path
      { ttfb: undefined as unknown as number },
      "http://x/"
    );
    expect(out).toEqual([]);
  });

  it("rounds measured ms in the message and includes the budget", () => {
    const out = checkPerformanceBudget(
      { ttfb: 250.7 },
      { ttfb: 200 },
      "http://x/",
      123456
    );
    expect(out[0]!.message).toBe("[perf-budget.ttfb] ttfb=251ms > budget 200ms");
    expect(out[0]!.timestamp).toBe(123456);
  });
});
