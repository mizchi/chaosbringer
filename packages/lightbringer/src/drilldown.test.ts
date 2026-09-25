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

// B14 (2026-09-24 evaluation): a navigating click's drilldown listed 64.6 ms
// and 50.6 ms "long tasks" while the span's blockingMs read 0. They were
// RunTasks of the browser process (CrBrowserMain, DevToolsPipeHandlerWriteThread),
// which the page's long-task observer rightly never sees. The tasks line
// must count renderer main-thread tasks only.
describe("analyseDrilldown RunTask line with thread metadata", () => {
  const meta = (pid: number, tid: number, name: string): DrilldownTraceEvent => ({
    name: "thread_name", ph: "M", pid, tid, args: { name },
  });
  const on = (pid: number, tid: number, e: DrilldownTraceEvent): DrilldownTraceEvent => ({ ...e, pid, tid });
  const traced: DrilldownTraceEvent[] = [
    meta(1, 1, "CrBrowserMain"),
    meta(1, 7, "DevToolsPipeHandlerWriteThread"),
    meta(2, 20, "CrRendererMain"),
    meta(2, 21, "Compositor"),
    meta(3, 30, "CrRendererMain"), // a second renderer (the navigated-to document's process)
    on(1, 1, X("RunTask", 1100, 64_600)),
    on(1, 7, X("RunTask", 1200, 50_600)),
    on(2, 21, X("RunTask", 1300, 55_000)),
    on(2, 20, X("RunTask", 1400, 2_000)),
    on(3, 30, X("RunTask", 1500, 70_000)),
  ];
  it("counts only renderer main-thread RunTasks", () => {
    const a = analyseDrilldown(span, traced);
    expect(a.tasks).toEqual({ totalMs: 72, count: 2, longTasksMs: [70] });
  });
  it("still counts every RunTask when the trace carries no thread names", () => {
    const bare = traced.filter((e) => e.ph !== "M");
    expect(analyseDrilldown(span, bare).tasks.count).toBe(5);
  });
});

// B13 (2026-09-24 evaluation): the drilldown's self-time table labelled the
// in-page collector a crawler injects as `[native]` — its bundled web-vitals
// (`A`, `i.m`, `r`), its anonymous callbacks, Playwright's `evaluate` /
// `query` — because injected scripts carry no URL and only a few exact
// function names were known. V8 gives each frame its script's scriptId (0
// for builtins), so a recognised frame now claims its whole script.
describe("analyseDrilldown harness attribution by script", () => {
  const node = (id: number, functionName: string, scriptId: number | string, url?: string) => ({
    id,
    callFrame: { functionName, scriptId, ...(url ? { url, lineNumber: 0 } : {}) },
  });
  const nodes = [
    node(1, "(root)", 0),
    node(2, "browserCollector", 3), // collector script (lightbringer browser.ts)
    node(3, "A", 3), // its minified web-vitals
    node(4, "", 3), // an anonymous collector callback
    node(5, "requestAnimationFrame", 0), // builtin: stays native
    node(6, "UtilityScript", 4), // Playwright utility script
    node(7, "evaluate", 4),
    node(8, "hot", 50), // URL-less app eval: nothing claims it
    node(9, "collectTargets", 60), // a caller's own injected helper
    node(10, "readTargets", 60), // another frame of that helper's script
    node(11, "main", 20, "http://localhost:5173/app.js"),
  ];
  // Samples 1 → 11 at 100 μs each, all inside the 1000..2000 window.
  const traced: DrilldownTraceEvent[] = [
    { name: "Profile", ph: "P", ts: 900, args: { data: { startTime: 900 } } },
    {
      name: "ProfileChunk",
      ph: "P",
      ts: 1000,
      args: {
        data: {
          cpuProfile: { nodes, samples: [3, 4, 5, 7, 8, 9, 10, 11] },
          timeDeltas: [200, 100, 100, 100, 100, 100, 100, 100],
        },
      },
    },
  ];
  const kinds = (a: ReturnType<typeof analyseDrilldown>) =>
    Object.fromEntries(a.self.ranked.map((r) => [r.key.trim(), r.kind]));

  it("labels every frame of a recognised injected script as harness, builtins stay native", () => {
    const k = kinds(analyseDrilldown(span, traced));
    expect(k["A"]).toBe("harness");
    expect(k["(anonymous)"]).toBe("harness");
    expect(k["evaluate"]).toBe("harness");
    // Not recognised without the caller's names: a URL-less script is not
    // assumed to be harness (it could be the app's own eval).
    expect(k["collectTargets"]).toBe("native");
    expect(k["readTargets"]).toBe("native");
    expect(k["requestAnimationFrame"]).toBe("native");
    expect(k["hot"]).toBe("native");
    expect(k["main  /app.js:1"]).toBe("app");
  });

  it("takes the caller's own injected function names, claiming their scripts too", () => {
    const a = analyseDrilldown(span, traced, { harnessFrames: ["collectTargets"] });
    const k = kinds(a);
    expect(k["collectTargets"]).toBe("harness");
    expect(k["readTargets"]).toBe("harness");
    expect(k["hot"]).toBe("native");
    // hot + requestAnimationFrame are the only native self time left.
    expect(Math.round(a.self.byKind.native * 10) / 10).toBe(0.2);
    expect(Math.round(a.self.byKind.harness * 10) / 10).toBe(0.6);
  });

  it("keeps a harness and a native frame of the same label on separate rows", () => {
    const anonApp = traced.map((e) =>
      e.name === "ProfileChunk"
        ? {
            ...e,
            args: {
              data: {
                cpuProfile: { nodes: [...nodes, node(12, "", 50)], samples: [4, 12, 12] },
                timeDeltas: [200, 100, 100],
              },
            },
          }
        : e,
    );
    const rows = analyseDrilldown(span, anonApp).self.ranked.filter((r) => r.key.trim() === "(anonymous)");
    expect(rows.map((r) => [r.kind, r.selfMs]).sort()).toEqual([
      ["harness", 0.2],
      ["native", 0.2],
    ]);
  });

  // lightbringer's own output keeps its original note; only a caller that
  // names its own switch (chaosbringer) gets wording without PERF_CSS.
  it("keeps the PERF_CSS note by default and a neutral one with the caller's hint", () => {
    const a2 = analyseDrilldown(span, events, { topN: 5 });
    const note = (lines: string[]) => lines.find((l) => l.startsWith("    note: "));
    expect(note(formatDrilldown(a2, { slug: "s", spanName: "click" }))).toMatch(
      /^ {4}note: PERF_CSS instruments every match attempt, so the recalc TIME is inflated/,
    );
    expect(
      note(formatDrilldown(a2, { slug: "s", spanName: "click", selectorStatsHint: "crawl with perf.cssSelectorStats" })),
    ).toMatch(/^ {4}note: SelectorStats instrument every match attempt, so the recalc TIME is inflated/);
  });

  it("lets the caller name its own SelectorStats switch in the hint", () => {
    const lines = formatDrilldown(analyseDrilldown({ ...span }, []), {
      slug: "s",
      spanName: "x",
      selectorStatsHint: "crawl with perf.cssSelectorStats",
    });
    expect(lines.at(-1)).toBe(
      "\n  CSS selector match cost: no SelectorStats in window (crawl with perf.cssSelectorStats to see per-selector cost)",
    );
  });
});
