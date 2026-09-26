import type { MediaReport, PerfReport } from "lightbringer/core";
import { describe, expect, it } from "vitest";
import { PERF_PAGE_LIST_CAP, toPagePerfSummary } from "./perf-trim.js";

/** A lightbringer page report with only the fields `toPagePerfSummary` reads. */
function report(extra: Partial<PerfReport> = {}, thirdParty = { requestCount: 0, encodedKB: 0 }): PerfReport {
  return {
    title: "t",
    url: "http://x.test/",
    vitals: { CLS: { value: 0.31, rating: "poor" }, FCP: { value: 812, rating: "good" } },
    spans: [],
    appSpans: [],
    network: {
      totalRequests: 9,
      totalEncodedKB: 120,
      fromCacheCount: 1,
      thirdParty: { ...thirdParty, byDomain: [] },
    },
    ...extra,
  } as unknown as PerfReport;
}

const oversized = (n: number): MediaReport["oversized"] =>
  Array.from({ length: n }, (_, i) => ({
    url: `http://x.test/img/${i}.png`,
    naturalPx: "1024x1024",
    renderedPx: "128x128",
    overFetch: 64,
    kb: 3000 - i,
  }));

const uncompressed = (n: number): MediaReport["uncompressed"] =>
  Array.from({ length: n }, (_, i) => ({ url: `http://x.test/${i}.js`, kb: 300 - i, ratio: 1, type: "script" }));

describe("toPagePerfSummary", () => {
  it("carries vitals (CLS included) and the network totals", () => {
    const s = toPagePerfSummary(report());
    expect(s.vitals.CLS?.value).toBe(0.31);
    expect(s.vitals.FCP?.value).toBe(812);
    expect(s.network).toEqual({ totalRequests: 9, totalEncodedKB: 120, fromCacheCount: 1 });
  });

  it("adds third-party totals only when there was third-party traffic", () => {
    expect(toPagePerfSummary(report()).network).not.toHaveProperty("thirdParty");
    const s = toPagePerfSummary(report({}, { requestCount: 5, encodedKB: 512.4 }));
    expect(s.network.thirdParty).toEqual({ requestCount: 5, encodedKB: 512.4 });
  });

  it("leaves media and renderBlocking absent when lightbringer reported none", () => {
    const s = toPagePerfSummary(report());
    expect(s).not.toHaveProperty("media");
    expect(s).not.toHaveProperty("renderBlocking");
    // lightbringer omits empty ones itself, but an empty object must not become zeros either.
    const empty = toPagePerfSummary(
      report({
        media: { imageCount: 0, imageKB: 0, oversized: [], uncompressed: [] },
        renderBlocking: { stylesheets: [], scripts: [] },
      }),
    );
    expect(empty).not.toHaveProperty("media");
    expect(empty).not.toHaveProperty("renderBlocking");
  });

  it("compacts media: counts count everything, lists keep the top entries with url/overFetch/kb and url/kb/ratio", () => {
    const s = toPagePerfSummary(
      report({
        media: {
          imageCount: 12,
          imageKB: 23000,
          oversized: oversized(10),
          uncompressed: uncompressed(2),
          oversizedCount: 12,
          uncompressedCount: 2,
        },
      }),
    );
    expect(s.media).toEqual({
      imageCount: 12,
      imageKB: 23000,
      oversizedCount: 12,
      oversized: oversized(PERF_PAGE_LIST_CAP).map(({ url, overFetch, kb }) => ({ url, overFetch, kb })),
      uncompressedCount: 2,
      uncompressed: uncompressed(2).map(({ url, kb, ratio }) => ({ url, kb, ratio })),
    });
  });

  it("falls back to the list lengths when lightbringer did not report the counts", () => {
    const s = toPagePerfSummary(
      report({ media: { imageCount: 4, imageKB: 12, oversized: oversized(4), uncompressed: [] } }),
    );
    expect(s.media?.oversizedCount).toBe(4);
    expect(s.media?.oversized).toHaveLength(PERF_PAGE_LIST_CAP);
    expect(s.media?.uncompressedCount).toBe(0);
  });

  it("keeps a measured zero when images were shown but none was flagged", () => {
    const s = toPagePerfSummary(
      report({ media: { imageCount: 8, imageKB: 1472, oversized: [], uncompressed: [], oversizedCount: 0, uncompressedCount: 0 } }),
    );
    expect(s.media).toMatchObject({ imageCount: 8, oversizedCount: 0, oversized: [], uncompressedCount: 0 });
  });

  it("counts render-blocking resources and lists the first urls, stylesheets first", () => {
    const s = toPagePerfSummary(
      report({ renderBlocking: { stylesheets: ["/a.css", "/b.css"], scripts: ["/x.js", "/y.js", "/z.js"] } }),
    );
    expect(s.renderBlocking).toEqual({ stylesheets: 2, scripts: 3, urls: ["/a.css", "/b.css", "/x.js"] });
  });

  it("does not mutate the report it was given", () => {
    const r = report({ media: { imageCount: 4, imageKB: 12, oversized: oversized(5), uncompressed: [] } });
    toPagePerfSummary(r);
    expect(r.media?.oversized).toHaveLength(5);
    expect(r.media?.oversized[0]).toHaveProperty("naturalPx");
  });
});
