import { describe, expect, it } from "vitest";
import { analyseDrilldown, formatDrilldown, type DrilldownSpan, type DrilldownTraceEvent } from "./drilldown";

// Window 1000..2000 μs.
const span: DrilldownSpan = {
  durationMs: 12,
  traceWindowUs: [1000, 2000],
  cpu: { blockingMs: 7 },
  render: { scriptMs: 3, gpuMs: 0.5, recalcStyleMs: 2 },
  network: {
    requestCount: 2,
    waves: 1,
    byInitiator: [{ frame: "main  /app.js:1", type: "script", requestCount: 2, encodedKB: 3.5 }],
  },
};

const X = (name: string, ts: number, dur: number, args?: unknown): DrilldownTraceEvent => ({
  name,
  ph: "X",
  ts,
  dur,
  args,
});

const events: DrilldownTraceEvent[] = [
  X("RunTask", 1100, 60_000),
  X("RunTask", 1200, 1_000),
  X("RunTask", 5000, 99_000), // outside the window
  X("FunctionCall", 1100, 4_000, {
    data: { functionName: "render", url: "http://localhost:5173/src/app.js", lineNumber: 7 },
  }),
  X("FunctionCall", 1150, 1_000, { data: { functionName: "", url: "" } }),
  X("EvaluateScript", 1300, 2_000, { data: { url: "http://localhost:5173/boot.js" } }),
  X("GPUTask", 1400, 500),
  X("RasterTask", 1400, 300),
  X("Decode Image", 1500, 200),
  { name: "Profile", ph: "P", ts: 900, args: { data: { startTime: 900 } } },
  {
    name: "ProfileChunk",
    ph: "P",
    ts: 1000,
    args: {
      data: {
        cpuProfile: {
          nodes: [
            { id: 1, callFrame: { functionName: "(root)" } },
            { id: 2, callFrame: { functionName: "render", url: "http://localhost:5173/src/app.js", lineNumber: 6 } },
            { id: 3, callFrame: { functionName: "track", url: "https://cdn.tracker.co.jp/t.js", lineNumber: 0 } },
            { id: 4, callFrame: { functionName: "isVisible" } },
            { id: 5, callFrame: { functionName: "JSON.parse" } },
          ],
          // cursor: 900 → 1000 (in) → 1300 → 1600 → 1700 → 1800 → 2100 (out)
          samples: [2, 2, 3, 4, 5, 1, 2],
        },
        timeDeltas: [100, 300, 300, 100, 100, 100, 300],
      },
    },
  },
  {
    name: "SelectorStats",
    ts: 1500,
    args: {
      selector_stats: {
        selector_timings: [
          { selector: ".a .b", "elapsed (us)": 3000, match_attempts: 10, fast_reject_count: 1, match_count: 4 },
          { selector: ".dead", "elapsed (us)": 500, match_attempts: 20, fast_reject_count: 0, match_count: 0 },
        ],
      },
    },
  },
  {
    name: "SelectorStats",
    ts: 9999, // outside
    args: { selector_stats: { selector_timings: [{ selector: ".late", "elapsed (us)": 1 }] } },
  },
];

describe("analyseDrilldown", () => {
  const a = analyseDrilldown(span, events, { pageUrl: "http://localhost:5173/", topN: 5 });

  it("sums main-thread tasks in the window and lists long ones", () => {
    expect(a.tasks).toEqual({ totalMs: 61, count: 2, longTasksMs: [60] });
  });

  it("ranks event names (RunTask excluded) and functions", () => {
    expect(a.byEventName[0]).toEqual({ name: "FunctionCall", totalMs: 5, count: 2 });
    expect(a.byEventName.some((r) => r.name === "RunTask")).toBe(false);
    expect(a.byFunction).toEqual([
      { key: "render  /src/app.js:7", totalMs: 4, count: 1 },
      { key: "(eval) /boot.js", totalMs: 2, count: 1 },
      { key: "(anonymous)  ", totalMs: 1, count: 1 },
    ]);
  });

  it("attributes profiler self time by kind and party, skipping synthetic frames", () => {
    // in-window samples: render 100+300 μs, track 300, isVisible 100, JSON.parse 100, (root) skipped
    expect(a.self.byKind).toEqual({ app: 0.7, harness: 0.1, native: 0.1 });
    expect(a.self.byParty.first).toBeCloseTo(0.4);
    expect(a.self.byParty.third).toBeCloseTo(0.3);
    expect(a.self.firstPartyDomain).toBe("localhost");
    expect(a.self.ranked[0]).toEqual({ key: "render  /src/app.js:7", selfMs: 0.4, kind: "app", party: "first" });
    expect(a.thirdPartyByDomain).toEqual([{ domain: "tracker.co.jp", selfMs: 0.3 }]);
  });

  it("collects GPU, decode, initiators and in-window selector cost", () => {
    expect(a.gpu.gpuTaskMs).toBe(0.5);
    expect(a.gpu.ranked.map((r) => r.name)).toEqual(["GPUTask", "RasterTask"]);
    expect(a.imageDecode).toEqual({ ms: 0.2, count: 1 });
    expect(a.initiators).toHaveLength(1);
    expect(a.selectors!.count).toBe(2);
    expect(a.selectors!.slowest.map((s) => s.selector)).toEqual([".a .b", ".dead"]);
    expect(a.selectors!.wasteful.map((s) => s.selector)).toEqual([".dead"]);
  });

  it("has no party split without a page url", () => {
    const b = analyseDrilldown(span, events);
    expect(b.self.firstPartyDomain).toBeNull();
    expect(b.self.ranked.every((r) => r.party === null)).toBe(true);
  });
});

describe("formatDrilldown", () => {
  it("prints the script's sections", () => {
    const lines = formatDrilldown(analyseDrilldown(span, events, { pageUrl: "http://localhost:5173/", topN: 5 }), {
      slug: "s",
      spanName: "click",
    });
    expect(lines.slice(0, 3)).toEqual([
      "\n[drilldown] s",
      'span "click"  dur=12ms  cpu.block=7ms  render.script=3ms',
      "  RunTask total 61ms / 2 tasks  (long tasks >=50ms: 60ms)",
    ]);
    expect(lines).toContain("         0.3ms  track  /t.js:1  [3p]");
    expect(lines).toContain("         0.1ms  isVisible    [harness]");
    expect(lines).toContain("    app self split: first-party 0.4ms / third-party 0.3ms  (page domain: localhost)");
    expect(lines).toContain("\n  network initiators (who issued the 2 requests, 1 waves):");
    expect(lines).toContain("           20 attempts  0.5ms  .dead");
  });

  it("explains empty sections", () => {
    const lines = formatDrilldown(analyseDrilldown(span, []), { slug: "s", spanName: "x" });
    expect(lines).toContain("  RunTask total 0ms / 0 tasks  (long tasks >=50ms: none)");
    expect(lines).toContain("    no matching events (v8.execute category may be missing from the trace)");
    expect(lines).toContain("    no CPU profiler samples in window (was PERF_TRACE=1 with v8.cpu_profiler?)");
    expect(lines.at(-1)).toBe(
      "\n  CSS selector match cost: no SelectorStats in window (run with PERF_CSS=1 to see per-selector cost)",
    );
  });
});
