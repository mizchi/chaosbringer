import type { SpanReport } from "lightbringer/core";
import { describe, expect, it } from "vitest";
import {
  actionKind,
  DEFAULT_PERF_TRACE_DIR,
  loadSpanName,
  PERF_REPORT_LIST_CAP,
  perfKey,
  perfOptionsFromCliFlags,
  perfSlug,
  resolvePerfOptions,
  toPerfSpanReport,
  urlPattern,
} from "./perf-key.js";

describe("urlPattern", () => {
  it("keeps only the pathname, so a baseline survives a port or host change", () => {
    expect(urlPattern("http://localhost:3000/cart")).toBe("/cart");
    expect(urlPattern("http://127.0.0.1:41873/cart")).toBe("/cart");
    expect(urlPattern("https://staging.example.com/cart")).toBe("/cart");
  });

  it("drops the query and the hash", () => {
    expect(urlPattern("http://x.test/search?q=shoes&page=2#results")).toBe("/search");
    expect(urlPattern("http://x.test/#/settings")).toBe("/");
  });

  it("collapses numeric, UUID and long-hex segments to :id", () => {
    expect(urlPattern("http://x.test/items/17")).toBe("/items/:id");
    expect(urlPattern("http://x.test/items/42/reviews/9")).toBe("/items/:id/reviews/:id");
    expect(urlPattern("http://x.test/u/3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe("/u/:id");
    expect(urlPattern("http://x.test/o/507f1f77bcf86cd799439011")).toBe("/o/:id");
  });

  it("leaves short hex-looking words alone — they are route names", () => {
    expect(urlPattern("http://x.test/cafe/add")).toBe("/cafe/add");
    expect(urlPattern("http://x.test/v2/abc123")).toBe("/v2/abc123");
  });

  it("groups trailing slashes the way the visited set does", () => {
    expect(urlPattern("http://x.test/docs/")).toBe(urlPattern("http://x.test/docs"));
    expect(urlPattern("http://x.test")).toBe("/");
  });

  it("strips query and hash from a string that is not an absolute URL", () => {
    expect(urlPattern("/items/7?x=1#y")).toBe("/items/:id");
  });
});

describe("actionKind / perfKey", () => {
  it("is `<type> <selector>` with the selector preferred over the target", () => {
    expect(actionKind({ type: "click", selector: "#buy", target: "Buy now" })).toBe("click #buy");
    expect(actionKind({ type: "click", target: "Buy now" })).toBe("click Buy now");
    expect(actionKind({ type: "click" })).toBe("click");
  });

  it("keys every scroll as `scroll`, not by its random offset", () => {
    expect(actionKind({ type: "scroll", target: "scrollY: 523" })).toBe("scroll");
    expect(actionKind({ type: "scroll", target: "scrollY: 17" })).toBe("scroll");
  });

  it("never carries a fill or select value into the key", () => {
    // `value` is not even an input to the key; a fill's text lives nowhere
    // on the ActionResult at all.
    const withValue = { type: "select" as const, selector: "#size", target: "Size", value: "XL" };
    expect(actionKind(withValue)).toBe("select #size");
    expect(perfKey("http://x.test/p/1?ref=a", actionKind(withValue))).toBe("/p/:id :: select #size");
  });

  it("joins the route pattern and the kind", () => {
    expect(perfKey("http://localhost:5173/items/9#top", "load")).toBe("/items/:id :: load");
  });

  it("names a load span by its real path", () => {
    expect(loadSpanName("http://x.test/items/9?q=1")).toBe("load /items/9");
  });
});

describe("resolvePerfOptions", () => {
  it("is null when perf is off", () => {
    expect(resolvePerfOptions(undefined)).toBeNull();
    expect(resolvePerfOptions(false)).toBeNull();
  });

  it("treats true as light level, actions measured, no artefacts", () => {
    expect(resolvePerfOptions(true)).toEqual({
      level: "light",
      memGc: false,
      coverage: false,
      cssSelectorStats: false,
      actions: true,
    });
  });

  it("maps the nested options through", () => {
    expect(
      resolvePerfOptions({
        memory: { forceGc: true },
        coverage: true,
        outDir: "out",
        actions: false,
      }),
    ).toEqual({
      level: "light",
      memGc: true,
      coverage: true,
      cssSelectorStats: false,
      outDir: "out",
      actions: false,
    });
  });

  it("makes cssSelectorStats imply trace level, and trace level imply a directory", () => {
    const r = resolvePerfOptions({ cssSelectorStats: true });
    expect(r?.level).toBe("trace");
    expect(r?.outDir).toBe(DEFAULT_PERF_TRACE_DIR);
    expect(resolvePerfOptions({ level: "trace", outDir: "mine" })?.outDir).toBe("mine");
  });
});

describe("perfOptionsFromCliFlags", () => {
  it("leaves perf unset without any flag", () => {
    expect(perfOptionsFromCliFlags({ perf: false })).toBeUndefined();
  });

  it("is plain `true` for a bare --perf", () => {
    expect(perfOptionsFromCliFlags({ perf: true })).toBe(true);
  });

  it("lets every sub-flag imply --perf", () => {
    expect(perfOptionsFromCliFlags({ "perf-trace": true })).toEqual({ level: "trace" });
    expect(perfOptionsFromCliFlags({ "perf-mem": true })).toEqual({ memory: { forceGc: true } });
    expect(perfOptionsFromCliFlags({ "perf-cov": true })).toEqual({ coverage: true });
    expect(perfOptionsFromCliFlags({ "perf-out": "p" })).toEqual({ outDir: "p" });
  });
});

function span(requests: number): SpanReport {
  const list = Array.from({ length: requests }, (_, i) => ({
    url: `http://x.test/r${i}`,
    type: "Fetch",
    startOffsetMs: i,
    durationMs: 100 - i,
    kb: 1,
    thirdParty: false,
  }));
  return {
    name: "action",
    durationMs: 12,
    capped: false,
    network: {
      requestCount: requests,
      encodedKB: requests,
      busyMs: 5,
      waves: 1,
      thirdParty: {
        requestCount: 0,
        encodedKB: 0,
        busyMs: 0,
        byDomain: Array.from({ length: requests }, (_, i) => ({
          domain: `d${i}.test`,
          requestCount: 1,
          encodedKB: 1,
          busyMs: 1,
        })),
      },
      byInitiator: Array.from({ length: requests }, (_, i) => ({
        frame: `f${i}`,
        type: "script",
        requestCount: 1,
        encodedKB: 1,
      })),
      requests: list,
    },
    cpu: { longTaskCount: 0, blockingMs: 0, maxLongTaskMs: 0, loafCount: 0, maxLoafBlockingMs: 0 },
    render: {} as SpanReport["render"],
    memory: {} as SpanReport["memory"],
    traceWindowUs: [0, 1],
    budget: { durationMs: 1 },
  };
}

describe("toPerfSpanReport", () => {
  it("caps the per-request lists but keeps the totals", () => {
    const out = toPerfSpanReport(span(20), "/ :: click #a", "click #a");
    expect(out.network.requests).toHaveLength(PERF_REPORT_LIST_CAP);
    expect(out.network.byInitiator).toHaveLength(PERF_REPORT_LIST_CAP);
    expect(out.network.thirdParty.byDomain).toHaveLength(PERF_REPORT_LIST_CAP);
    expect(out.network.requestCount).toBe(20);
    expect(out.network.encodedKB).toBe(20);
    // The kept entries are the head of lightbringer's (slowest-first) list.
    expect(out.network.requests[0]?.url).toBe("http://x.test/r0");
  });

  it("sets key and name and drops the budget", () => {
    const out = toPerfSpanReport(span(1), "/ :: load", "load /");
    expect(out.key).toBe("/ :: load");
    expect(out.name).toBe("load /");
    expect("budget" in out).toBe(false);
  });

  it("does not mutate the span it was given", () => {
    const s = span(8);
    toPerfSpanReport(s, "k", "n");
    expect(s.network.requests).toHaveLength(8);
    expect(s.name).toBe("action");
  });
});

describe("perfSlug", () => {
  it("prefixes the run id and page index and makes the route file-safe", () => {
    expect(perfSlug("http://x.test/items/7?x=1", 3, "ab12cd34")).toBe("ab12cd34-003-items-id");
    expect(perfSlug("http://x.test/", 0, "ab12cd34")).toBe("ab12cd34-000-root");
    expect(perfSlug("http://x.test/a b/c.d", 12, "ab12cd34")).toBe("ab12cd34-012-a-20b-c-d");
  });

  it("gives the same page of two runs different stems", () => {
    expect(perfSlug("http://x.test/", 0, "aaaaaaaa")).not.toBe(perfSlug("http://x.test/", 0, "bbbbbbbb"));
  });
});
