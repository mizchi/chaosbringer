import type { SpanReport } from "lightbringer/core";
import { describe, expect, it } from "vitest";
import {
  actionKind,
  actionRouteUrl,
  attemptedActionType,
  candidatePerfKey,
  loadSpanName,
  perfKey,
  perfSlug,
  urlPattern,
} from "./perf-key.js";
import { DEFAULT_PERF_TRACE_DIR, perfOptionsFromCliFlags, resolvePerfOptions } from "./perf-options.js";
import {
  formatLastActionPerf,
  PERF_REPORT_LIST_CAP,
  toLastActionPerf,
  toPerfSpanReport,
} from "./perf-trim.js";

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

  it("keeps settledMs and settledUnfinished, computed by lightbringer before any cap", () => {
    const s = span(20);
    s.network = { ...s.network, settledMs: 912, settledUnfinished: true };
    const out = toPerfSpanReport(s, "/ :: click #a", "click #a");
    expect(out.network.requests).toHaveLength(PERF_REPORT_LIST_CAP);
    expect(out.network.settledMs).toBe(912);
    expect(out.network.settledUnfinished).toBe(true);
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

describe("attemptedActionType / candidatePerfKey", () => {
  it("maps each target type to the result type the crawler records", () => {
    expect(attemptedActionType("scroll")).toBe("scroll");
    expect(attemptedActionType("select")).toBe("select");
    expect(attemptedActionType("input")).toBe("input");
    expect(attemptedActionType("input", "clear")).toBe("clear");
    for (const t of ["link", "button", "interactive"] as const) expect(attemptedActionType(t)).toBe("click");
  });

  it("gives a candidate the key its action's span will carry", () => {
    const url = "http://localhost:3000/items/42?tab=1";
    expect(candidatePerfKey(url, { type: "button", selector: "#save" })).toBe(
      perfKey(url, actionKind({ type: "click", selector: "#save", target: "Save" })),
    );
    expect(candidatePerfKey(url, { type: "input", selector: "#q" })).toBe("/items/:id :: input #q");
    // A scroll result has no selector, so neither does its key.
    expect(candidatePerfKey(url, { type: "scroll", selector: "window" })).toBe(
      perfKey(url, actionKind({ type: "scroll", target: "scrollY: 523" })),
    );
  });
});

describe("toLastActionPerf / formatLastActionPerf", () => {
  it("keeps only the picked facts, and interaction only when measured", () => {
    const s = span(3);
    const out = toLastActionPerf({ ...s, durationMs: 40, cpu: { ...s.cpu, blockingMs: 12, longTaskCount: 1 } }, "k");
    expect(out).toEqual({
      key: "k",
      durationMs: 40,
      cpu: { blockingMs: 12, longTaskCount: 1 },
      network: { requestCount: 3, encodedKB: 3 },
    });
    expect("interaction" in out).toBe(false);
    const interaction = {
      count: 1,
      maxDurationMs: 90,
      type: "click",
      inputDelayMs: 1,
      processingMs: 80,
      presentationMs: 9,
    };
    expect(toLastActionPerf({ ...s, interaction }, "k").interaction).toEqual(interaction);
  });

  it("formats one line, singular where it should be", () => {
    expect(
      formatLastActionPerf({
        durationMs: 20,
        cpu: { blockingMs: 0, longTaskCount: 1 },
        network: { requestCount: 1, encodedKB: 0.5 },
      }),
    ).toBe("Previous action cost: 20ms, 0ms main-thread blocking over 1 long task, 1 request (0.5 KB)");
  });
});

describe("actionRouteUrl", () => {
  const visit = "http://localhost:3000/list";
  it("follows the live URL on the visit's origin", () => {
    expect(actionRouteUrl(visit, "http://localhost:3000/items/7?x=1")).toBe("http://localhost:3000/items/7?x=1");
  });
  it("keeps the visit URL for another origin, an error page, or nothing", () => {
    expect(actionRouteUrl(visit, "https://elsewhere.test/")).toBe(visit);
    expect(actionRouteUrl(visit, "chrome-error://chromewebdata/")).toBe(visit);
    expect(actionRouteUrl(visit, "about:blank")).toBe(visit);
    expect(actionRouteUrl(visit, undefined)).toBe(visit);
  });
});

describe("candidatePerfKey with a driver step", () => {
  const button = { type: "button" as const, selector: "#buy" };
  it("keys by the route the page is on, not the visit", () => {
    const step = { url: "http://localhost:3000/list", currentUrl: "http://localhost:3000/items/7" };
    expect(candidatePerfKey(step, button)).toBe("/items/:id :: click #buy");
  });
  it("is the visit key while the page has not left it", () => {
    const step = { url: "http://localhost:3000/list", currentUrl: "http://localhost:3000/list" };
    expect(candidatePerfKey(step, button)).toBe(candidatePerfKey(step.url, button));
  });
});
