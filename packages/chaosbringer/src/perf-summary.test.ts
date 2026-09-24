import { describe, expect, it } from "vitest";
import { fakeAction, fakePage, fakeSpan } from "./perf-fixtures.test-helpers.js";
import { buildCrawlPerfSummary, PERF_SUMMARY_TOP_N } from "./perf-summary.js";
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
