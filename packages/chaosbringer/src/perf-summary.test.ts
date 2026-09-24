import { describe, expect, it } from "vitest";
import { fakeAction, fakePage, fakeSpan } from "./perf-fixtures.test-helpers.js";
import {
  buildCoverageSummary,
  buildCrawlPerfSummary,
  buildPerfTrends,
  COVERAGE_LOW_USAGE_TOP_N,
  PERF_SUMMARY_TOP_N,
} from "./perf-summary.js";
import type { PageResult } from "./types.js";

function withVitals(url: string, vitals: Record<string, number>): PageResult {
  return fakePage(url, fakeSpan(`${new URL(url).pathname} :: load`), {
    perfPage: {
      vitals: Object.fromEntries(
        Object.entries(vitals).map(([k, value]) => [k, { value, rating: "good" } as never]),
      ),
      network: { totalRequests: 0, totalEncodedKB: 0, fromCacheCount: 0 },
    },
  });
}

describe("buildCrawlPerfSummary", () => {
  it("is undefined when nothing was measured", () => {
    expect(buildCrawlPerfSummary([fakePage("http://x/")], [fakeAction()])).toBeUndefined();
  });

  it("summarises each vital as p50 / p75 / worst with the worst page", () => {
    const pages = [
      withVitals("http://x/a", { LCP: 1000, CLS: 0.01 }),
      withVitals("http://x/b", { LCP: 3000, CLS: 0.25 }),
      withVitals("http://x/c", { LCP: 2000 }),
      withVitals("http://x/d", { LCP: 1500, TTFB: 80 }),
    ];
    const s = buildCrawlPerfSummary(pages, [])!;
    // nearest-rank over [1000, 1500, 2000, 3000]
    expect(s.vitals.LCP).toEqual({ p50: 2000, p75: 2000, worst: { value: 3000, url: "http://x/b" } });
    // CLS keeps its thousandths
    expect(s.vitals.CLS).toEqual({ p50: 0.25, p75: 0.25, worst: { value: 0.25, url: "http://x/b" } });
    expect(s.vitals.TTFB?.worst).toEqual({ value: 80, url: "http://x/d" });
    // a vital no page reported is absent, not 0
    expect(s.vitals.INP).toBeUndefined();
    expect(Object.keys(s.vitals)).toEqual(["LCP", "CLS", "TTFB"]);
    expect(s.totals).toEqual({ spans: 4, pages: 4 });
  });

  it("keeps the 10 slowest actions, slowest first", () => {
    const actions = Array.from({ length: 12 }, (_, i) =>
      fakeAction(fakeSpan(`/ :: click #b${i}`, { durationMs: i * 10, blockingMs: i, ...(i === 11 ? { interactionMs: 90 } : {}) })),
    );
    const s = buildCrawlPerfSummary([], actions)!;
    expect(s.slowestActions).toHaveLength(PERF_SUMMARY_TOP_N);
    expect(s.slowestActions[0]).toEqual({ key: "/ :: click #b11", durationMs: 110, blockingMs: 11, interactionMs: 90 });
    expect(s.slowestActions[1]).toEqual({ key: "/ :: click #b10", durationMs: 100, blockingMs: 10 });
    expect(s.totals).toEqual({ spans: 12, pages: 0 });
  });

  it("adds initiators and third-party domains up across spans", () => {
    const load = fakeSpan("/ :: load", {
      initiators: [
        { frame: "app.js:1", requestCount: 3, encodedKB: 10 },
        { frame: "parser", requestCount: 1, encodedKB: 50 },
      ],
      thirdParty: [{ domain: "cdn.com", requestCount: 2, encodedKB: 20, busyMs: 30 }],
    });
    const click = fakeSpan("/ :: click #a", {
      initiators: [{ frame: "app.js:1", requestCount: 2, encodedKB: 5.55 }],
      thirdParty: [
        { domain: "cdn.com", requestCount: 1, encodedKB: 1, busyMs: 5 },
        { domain: "ads.net", requestCount: 1, encodedKB: 90, busyMs: 1 },
      ],
    });
    const s = buildCrawlPerfSummary([fakePage("http://x/", load)], [fakeAction(click)])!;
    expect(s.hotInitiators).toEqual([
      { frame: "app.js:1", requestCount: 5, encodedKB: 15.6 },
      { frame: "parser", requestCount: 1, encodedKB: 50 },
    ]);
    expect(s.thirdParty).toEqual([
      { domain: "ads.net", requestCount: 1, encodedKB: 90, busyMs: 1 },
      { domain: "cdn.com", requestCount: 3, encodedKB: 21, busyMs: 35 },
    ]);
  });
});

describe("buildPerfTrends", () => {
  const mem = (jsEventListeners: number) => ({
    jsHeapUsedMB: 5,
    jsHeapDeltaMB: 0,
    arrayBuffers: 0,
    domNodes: 100,
    jsEventListeners,
    listenersDelta: 0,
    documentsDelta: 0,
  });
  const click = (listeners: number, timestamp: number) => ({
    ...fakeAction(fakeSpan("/app :: click #nav", { memory: mem(listeners) })),
    timestamp,
  });

  it("flags listeners climbing across repeats of one key, in time order", () => {
    // pushed out of order: the trend is over timestamps, not array order
    const actions = [click(30, 1), click(90, 3), click(60, 2), click(120, 4), click(150, 5)];
    const trends = buildPerfTrends([], actions);
    expect(trends).toEqual([
      expect.objectContaining({
        name: "/app :: click #nav",
        metric: "jsEventListeners",
        count: 5,
        values: [30, 60, 90, 120, 150],
        growth: 120,
        leak: true,
      }),
    ]);
    expect(buildCrawlPerfSummary([], actions)!.trends).toEqual(trends);
  });

  it("needs three repeats, and ignores a flat series or spans without memory", () => {
    expect(buildPerfTrends([], [click(30, 1), click(130, 2)])).toEqual([]);
    expect(buildPerfTrends([], [click(30, 1), click(30, 2), click(31, 3), click(30, 4)])).toEqual([]);
    const noMem = [1, 2, 3, 4].map((t) => ({ ...fakeAction(fakeSpan("/x :: click #a")), timestamp: t }));
    expect(buildPerfTrends([], noMem)).toEqual([]);
    expect(buildCrawlPerfSummary([], noMem)!.trends).toBeUndefined();
  });

  it("skips steps that created a document: their gauges count the garbage left behind", () => {
    const navs = [66, 100, 134, 168].map((n, t) => ({
      ...fakeAction(fakeSpan("/a :: click a#next", { memory: { ...mem(n), documentsDelta: 1 } })),
      timestamp: t,
    }));
    expect(buildPerfTrends([], navs)).toEqual([]);
  });

  it("does not trend a key across a navigation: the kept spans carry the garbage too", () => {
    // A no-op button clicked between nav clicks on one visit: its totals climb
    // by what each navigated-away document left behind, not by retention.
    const at = (key: string, listeners: number, documentsDelta: number, timestamp: number) => ({
      ...fakeAction(fakeSpan(key, { memory: { ...mem(listeners), documentsDelta } })),
      timestamp,
    });
    const actions = [];
    let t = 0;
    for (let i = 0; i < 5; i++) {
      actions.push(at("/ :: click #noop", 300 + i * 74, 0, t++));
      actions.push(at("/ :: click a#home", 340 + i * 74, 1, t++));
    }
    expect(buildPerfTrends([], actions)).toEqual([]);
  });

  it("still trends a run within one document, even after a navigation", () => {
    const at = (key: string, listeners: number, documentsDelta: number, timestamp: number) => ({
      ...fakeAction(fakeSpan(key, { memory: { ...mem(listeners), documentsDelta } })),
      timestamp,
    });
    const actions = [
      at("/ :: click #leak", 500, 0, 0),
      at("/ :: click a#home", 900, 1, 1),
      ...[30, 60, 90, 120].map((n, i) => at("/ :: click #leak", n, 0, 2 + i)),
    ];
    expect(buildPerfTrends([], actions)).toEqual([
      expect.objectContaining({ name: "/ :: click #leak", count: 4, values: [30, 60, 90, 120], leak: true }),
    ]);
  });
});

describe("crawl-wide coverage", () => {
  it("unions the crawl's artifact and lists the least-used resources", () => {
    const js = Array.from({ length: 12 }, (_, i) => ({
      url: `http://x/c${i}.js`,
      total: 1000,
      used: [[0, i * 50]] as Array<[number, number]>,
    }));
    const c = buildCoverageSummary({ js, css: [] });
    expect(c.js.totalBytes).toBe(12_000);
    expect(c.js.usedBytes).toBe(3300);
    expect(c.js.usedPct).toBe(27.5);
    expect(c.js.lowUsage).toHaveLength(COVERAGE_LOW_USAGE_TOP_N);
    expect(c.js.lowUsage[0]).toEqual({ url: "http://x/c0.js", totalBytes: 1000, usedBytes: 0, usedPct: 0 });
    expect(c.css).toEqual({ totalBytes: 0, usedBytes: 0, usedPct: 0, lowUsage: [] });

    const load = fakeSpan("/ :: load");
    const s = buildCrawlPerfSummary([fakePage("http://x/", load)], [], { coverage: { js } })!;
    expect(s.coverage?.js.usedPct).toBe(27.5);
    expect(buildCrawlPerfSummary([fakePage("http://x/", load)], [])!.coverage).toBeUndefined();
  });
});

describe("degradation in the summary", () => {
  it("is present only when some key has both sides", () => {
    const k = "/item/:id :: load";
    const pages = [
      fakePage("http://x/item/1", fakeSpan(k, { durationMs: 500, faults: ["delay"] })),
      fakePage("http://x/item/2", fakeSpan(k, { durationMs: 100 })),
    ];
    expect(buildCrawlPerfSummary(pages, [])!.degradation).toEqual([
      expect.objectContaining({ key: k, fault: "delay", delta: expect.objectContaining({ durationMs: 400 }) }),
    ]);
    expect(buildCrawlPerfSummary([pages[1]!], [])!.degradation).toBeUndefined();
  });
});
