import { describe, expect, it } from "vitest";
import type { PaintWaitResult } from "lightbringer/core";
import { checkPerformanceBudget, unmeasuredBudget } from "./budget.js";
import type { LoadMetricsRead, LoadPaintHint } from "./page-metrics.js";

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

describe("unmeasuredBudget", () => {
  const ORIGIN = 1_700_000_000_000;
  const hint = (over: Partial<LoadPaintHint> = {}): LoadPaintHint => ({
    timeOrigin: ORIGIN,
    visible: true,
    collector: true,
    webVitals: true,
    hiddenEntry: false,
    fcpVital: false,
    lateImages: 0,
    input: false,
    ...over,
  });
  const read = (over: Partial<LoadPaintHint> = {}): LoadMetricsRead => ({
    metrics: {},
    longTasks: [],
    paint: hint(over),
  });
  const wait = (over: Partial<PaintWaitResult>): PaintWaitResult => ({
    outcome: "none",
    collector: true,
    timeOrigin: ORIGIN,
    fcp: null,
    lcp: null,
    waitedMs: 0,
    frames: 0,
    initial: [],
    final: [],
    ...over,
  });
  const reasons = (out: ReturnType<typeof unmeasuredBudget>) => out.map((u) => [u.metric, u.reason]);

  it("notes nothing without a budget, or when every budgeted metric was measured", () => {
    expect(unmeasuredBudget({}, undefined, { capped: false, read: read(), paint: null })).toEqual([]);
    expect(
      unmeasuredBudget({ fcp: 30, lcp: 40 }, { fcp: 1000, lcp: 1000 }, { capped: false, read: read(), paint: null }),
    ).toEqual([]);
  });

  it("names only budgeted metrics", () => {
    const out = unmeasuredBudget({ fcp: 30 }, { lcp: 1000 }, { capped: false, read: read({ collector: false }), paint: null });
    expect(reasons(out)).toEqual([["lcp", "no-collector"]]);
  });

  it("says no-content for a page that showed nothing to paint", () => {
    const out = unmeasuredBudget({}, { fcp: 1000 }, { capped: false, read: read(), paint: wait({ outcome: "none" }) });
    expect(out).toEqual([{ metric: "fcp", reason: "no-content", message: "the page showed no contentful content" }]);
  });

  it("says capped when the load settle capped", () => {
    const out = unmeasuredBudget({}, { fcp: 1000, lcp: 1000 }, { capped: true, read: read(), paint: null });
    expect(reasons(out)).toEqual([
      ["fcp", "capped"],
      ["lcp", "capped"],
    ]);
  });

  it("says hidden for a hidden document, from the read or the wait", () => {
    expect(reasons(unmeasuredBudget({}, { fcp: 1 }, { capped: false, read: read({ visible: false }), paint: null }))).toEqual([
      ["fcp", "hidden"],
    ]);
    expect(
      reasons(unmeasuredBudget({}, { fcp: 1 }, { capped: false, read: read(), paint: wait({ outcome: "hidden" }) })),
    ).toEqual([["fcp", "hidden"]]);
  });

  it("tells a stall (frames stopped) from a paint the browser did not count (frames ran)", () => {
    const stalled = unmeasuredBudget({}, { fcp: 1 }, {
      capped: false,
      read: read(),
      paint: wait({ outcome: "timeout", waitedMs: 1000.4, frames: null, initial: ["fcp"], final: ["fcp"] }),
    });
    expect(stalled).toEqual([
      {
        metric: "fcp",
        reason: "stalled",
        message: "content was visible but no first contentful paint was reported within 1000 ms: frames stopped",
      },
    ]);
    const counted = unmeasuredBudget({}, { fcp: 1 }, {
      capped: false,
      read: read(),
      paint: wait({ outcome: "frames", waitedMs: 90, frames: 6, initial: ["fcp"], final: ["fcp"] }),
    });
    expect(counted).toEqual([
      {
        metric: "fcp",
        reason: "not-presented",
        message: "content was visible but no first contentful paint was reported within 6 frames",
      },
    ]);
  });

  it("says no-collector for LCP / TBT on a page without the collector, but not for FCP", () => {
    const out = unmeasuredBudget({}, { fcp: 1, lcp: 1, tbt: 1 }, {
      capped: false,
      read: read({ collector: false }),
      paint: wait({ outcome: "none", collector: false }),
    });
    expect(reasons(out)).toEqual([
      ["fcp", "no-content"],
      ["lcp", "no-collector"],
      ["tbt", "no-collector"],
    ]);
  });

  it("says not-reported for the navigation metrics, a failed read, and a check that never answered", () => {
    expect(reasons(unmeasuredBudget({}, { ttfb: 1, load: 1 }, { capped: false, read: read(), paint: null }))).toEqual([
      ["ttfb", "not-reported"],
      ["load", "not-reported"],
    ]);
    expect(
      reasons(unmeasuredBudget({}, { fcp: 1, ttfb: 1 }, { capped: false, read: { metrics: {}, longTasks: null, paint: null }, paint: null })),
    ).toEqual([
      ["ttfb", "not-reported"],
      ["fcp", "not-reported"],
    ]);
    expect(reasons(unmeasuredBudget({}, { fcp: 1 }, { capped: false, read: null, paint: null }))).toEqual([["fcp", "not-reported"]]);
    expect(
      reasons(unmeasuredBudget({}, { fcp: 1 }, { capped: false, read: read(), paint: wait({ outcome: "error", collector: null }) })),
    ).toEqual([["fcp", "not-reported"]]);
  });

  it("says not-reported, not not-presented, when the page navigated during a wait for a pending FCP", () => {
    // An error keeps what was pending at the start as `final`, with no frames.
    const out = unmeasuredBudget({}, { fcp: 1000, lcp: 1000 }, {
      capped: false,
      read: read(),
      paint: wait({ outcome: "error", collector: null, timeOrigin: null, waitedMs: 40, frames: 0, initial: ["fcp"], final: ["fcp"] }),
    });
    expect(out).toEqual([
      { metric: "fcp", reason: "not-reported", message: "the page navigated or closed during the paint check" },
      { metric: "lcp", reason: "not-reported", message: "the page navigated or closed during the paint check" },
    ]);
  });

  it("flags a measured LCP as under-read only when frames stopped with a larger image unpresented", () => {
    const lcpImage = { url: "http://x/img/hero.png", area: 360000, candidateSize: 9000, bpp: 22 };
    const timeout = wait({ outcome: "timeout", waitedMs: 1000, frames: null, initial: ["lcp-image"], final: ["lcp-image"], lcpImage });
    expect(unmeasuredBudget({ lcp: 24.4 }, { lcp: 500 }, { capped: false, read: read(), paint: timeout })).toEqual([
      {
        metric: "lcp",
        reason: "under-read",
        message: "a larger image (http://x/img/hero.png) loaded but was not presented within 1000 ms; lcp=24 is an earlier candidate",
      },
    ]);
    // Frames ran and the image never became LCP: the estimate was wrong, not the value.
    const frames = wait({ outcome: "frames", frames: 6, initial: ["lcp-image"], final: ["lcp-image"], lcpImage });
    expect(unmeasuredBudget({ lcp: 24 }, { lcp: 500 }, { capped: false, read: read(), paint: frames })).toEqual([]);
    // It arrived.
    expect(unmeasuredBudget({ lcp: 1044 }, { lcp: 500 }, { capped: false, read: read(), paint: wait({ outcome: "reported", initial: ["lcp-image"] }) })).toEqual([]);
  });

  it("leaves checkPerformanceBudget silent on the same absent metrics", () => {
    expect(checkPerformanceBudget({}, { fcp: 1, lcp: 1, tbt: 1 }, "http://x/")).toEqual([]);
  });
});
