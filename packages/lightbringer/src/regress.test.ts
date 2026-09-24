import { describe, expect, it } from "vitest";
import {
  classifyChange,
  formatPct,
  formatRegress,
  REGRESS_SPAN_METRICS,
  regress,
  relativeChange,
  type RegressInput,
} from "./regress";

describe("default floors", () => {
  // lightbringer-regress's published behaviour: callers with noisier runs
  // (chaosbringer crawls) raise these through `floors`, not the defaults.
  it("keeps the frame floors at 2 dropped frames and 16 ms", () => {
    const floor = (k: string) => REGRESS_SPAN_METRICS.find((m) => m.key === k)?.floor;
    expect(floor("droppedFrames")).toBe(2);
    expect(floor("longestFrameMs")).toBe(16);
  });
});
import { stat, type MedianSpan, type Stat } from "./stats";

const s = (median: number, noisy = false): Stat => ({
  median,
  p25: median,
  p75: median,
  min: median,
  max: median,
  noisy,
  n: 3,
});

function mspan(name: string, durationMs: Stat, blockingMs: Stat = s(0)): MedianSpan {
  return {
    name,
    durationMs,
    network: { busyMs: s(0), waves: s(0), encodedKB: s(0), requestCount: s(0), thirdPartyKB: s(0), thirdPartyRequestCount: s(0) },
    cpu: { blockingMs, maxLongTaskMs: s(0) },
    render: { recalcStyleCount: s(0), recalcStyleMs: s(0), layoutCount: s(0), layoutMs: s(0), nodes: s(0), scriptMs: s(0) },
  };
}

describe("relativeChange / formatPct", () => {
  it("treats growth from 0 as new", () => {
    expect(relativeChange(0, 5)).toBe(Infinity);
    expect(relativeChange(0, 0)).toBe(0);
    expect(formatPct(Infinity)).toBe("new");
    expect(formatPct(0.1234)).toBe("+12%");
    expect(formatPct(-0.5)).toBe("-50%");
    expect(formatPct(0)).toBe("+0%");
  });
});

describe("classifyChange", () => {
  it("needs both the relative threshold and the absolute floor", () => {
    expect(classifyChange(s(1), s(2), 5)!.kind).toBe("ok"); // +100% but only +1
    expect(classifyChange(s(100), s(114), 5)!.kind).toBe("ok"); // +14%
    expect(classifyChange(s(100), s(116), 5)!.kind).toBe("regression");
    expect(classifyChange(s(100), s(116), 20)!.kind).toBe("ok");
    expect(classifyChange(s(100), s(80), 5)!.kind).toBe("improvement");
  });
  it("downgrades a would-be regression on a noisy side to noisy", () => {
    expect(classifyChange(s(100, true), s(200), 5)!.kind).toBe("noisy");
    expect(classifyChange(s(100), s(200, true), 5)!.kind).toBe("noisy");
    // improvements are not downgraded
    expect(classifyChange(s(200, true), s(100), 5)!.kind).toBe("improvement");
  });
  it("is null when either side did not measure the metric", () => {
    expect(classifyChange(undefined, s(1), 1)).toBeNull();
  });
  it("honours a custom threshold", () => {
    expect(classifyChange(s(100), s(110), 5, 0.05)!.kind).toBe("regression");
  });
});

describe("regress", () => {
  const baseline = new Map([
    ["a", { spans: [mspan("load", s(100), s(50))], vitals: { LCP: s(1000), CLS: s(0.1) } }],
  ]);

  it("reports regressions, noisy warnings, improvements, new spans and unmatched slugs", () => {
    const current = new Map<string, RegressInput>([
      [
        "a",
        {
          spans: [mspan("load", s(200), s(20)), mspan("extra", s(1))],
          vitals: { LCP: s(2000, true), CLS: s(0.1) },
        },
      ],
      ["b", { spans: [], vitals: {} }],
    ]);
    const r = regress(baseline, current);
    expect(r.regressions.map((f) => f.subject)).toEqual(["load.durationMs"]);
    expect(r.warnings.map((f) => [f.subject, f.vital])).toEqual([["vitals.LCP", true]]);
    expect(r.improvements).toBe(1); // blockingMs 50 → 20
    expect(r.slugs.map((x) => [x.slug, x.hasBaseline])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    expect(r.slugs[0]!.lines.map((l) => l.type)).toEqual(["change", "change", "new-span", "change"]);

    const out = formatRegress(r, { baselineLabel: "base", currentLabel: "cur" });
    expect(out.failed).toBe(true);
    expect(out.stdout).toEqual([
      "\n[regress] baseline base  vs  current cur  (gate: +15%)",
      "\n  a\n    load / durationMs  100 → 200  (+100%)  ✗\n    load / cpu.blockingMs  50 → 20  (-60%)  ✓\n" +
        '    span "extra" is new (no baseline)\n    vitals.LCP  1000 → 2000  (+100%)  ~',
      "\n  b  (no baseline — skipped)",
      "",
      "  ✓ 1 improvement(s)",
      "\n[regress] noisy (warn only, 1):",
      "  ~ a / vitals.LCP 1000 → 2000 (+100%) — noisy",
    ]);
    expect(out.stderr).toEqual([
      "\n[regress] REGRESSIONS (1):",
      "  ✗ a / load.durationMs 100 → 200 (+100%)",
    ]);
  });

  it("span warnings say they cannot gate; a clean run passes", () => {
    const noisy = regress(baseline, { a: { spans: [mspan("load", s(200, true), s(50))] } });
    const out = formatRegress(noisy, { baselineLabel: "b", currentLabel: "c" });
    expect(out.stdout).toContain("  ~ a / load.durationMs 100 → 200 (+100%) — noisy, can't gate");
    expect(out.failed).toBe(false);
    expect(out.stdout.at(-1)).toBe("\n[regress] no regressions past the gate.");
  });

  it("accepts floor overrides by metric key", () => {
    const cur = { a: { spans: [mspan("load", s(200), s(50))] } };
    expect(regress(baseline, cur, { floors: { durationMs: 500 } }).regressions).toHaveLength(0);
  });

  it("reads real Stats (median of runs)", () => {
    const cur = { a: { spans: [mspan("load", stat([150, 160, 170]), s(50))] } };
    expect(regress(baseline, cur).regressions[0]!.change).toMatchObject({ base: 100, cur: 160 });
  });
});
