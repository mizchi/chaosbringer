import { describe, expect, it } from "vitest";
import type { ErrorCluster } from "../clusters.js";
import { fakeAction, fakePage, fakeReport, fakeSpan } from "../perf-fixtures.test-helpers.js";
import type { PagePerfSummary, PerfSpanReport } from "../types.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { analyzeScan, assetIdentity, RULE_PATTERNS, SCAN_FAULT_NAMES, SCAN_THRESHOLDS, SCAN_WHERE_CAP } from "./analyze.js";
import { withSidecarRequests } from "./sidecars.js";
import { deriveScanEndpoints, endpointsPattern } from "./endpoints.js";
import { formatScanMarkdown, formatScanSummary } from "./format.js";
import { parseFaults } from "./cli.js";

const U = "http://localhost:3000";

function cluster(type: ErrorCluster["type"], message: string, urls = [`${U}/`], count = 1): ErrorCluster {
  return {
    key: `${type}|${message}`,
    type,
    fingerprint: message,
    sample: { type, message, timestamp: 0, stack: `Error: ${message}\n    at render (${U}/app.js:10:5)` },
    count,
    urls,
  };
}

function perfPage(o: Partial<PagePerfSummary> = {}): PagePerfSummary {
  return { vitals: {}, network: { totalRequests: 1, totalEncodedKB: 10, fromCacheCount: 0 }, ...o };
}

function vital(value: number) {
  return { value, rating: "", attribution: {} };
}

function span(key: string, patch: (s: PerfSpanReport) => void): PerfSpanReport {
  const s = fakeSpan(key);
  patch(s);
  return s;
}

const rules = (r: ReturnType<typeof analyzeScan>) => r.findings.map((f) => f.rule);

describe("analyzeScan: bugs", () => {
  it("reports failed, 5xx and 4xx pages with where they were linked from", () => {
    const r = analyzeScan(
      fakeReport(
        [
          fakePage(`${U}/`),
          fakePage(`${U}/slow`, undefined, { status: "timeout" }),
          fakePage(`${U}/boom`, undefined, { statusCode: 500 }),
          fakePage(`${U}/gone`, undefined, { statusCode: 404, sourceUrl: `${U}/` }),
        ],
        [],
      ),
    );
    expect(rules(r)).toEqual(["http-5xx", "page-load-failed", "broken-link"]);
    const broken = r.findings.find((f) => f.rule === "broken-link")!;
    expect(broken.severity).toBe("medium");
    expect(broken.evidence[0]).toBe(`${U}/gone: HTTP 404 (linked from ${U}/)`);
  });

  it("turns each error cluster into a finding, exceptions first", () => {
    const r = analyzeScan(
      fakeReport([fakePage(`${U}/`)], [], {
        errorClusters: [
          cluster("console", "something logged"),
          cluster("exception", "TypeError: x is undefined", [`${U}/`, `${U}/a`], 3),
          cluster("network", "https://api.test/x - net::ERR_NAME_NOT_RESOLVED"),
        ],
      }),
    );
    expect(r.findings.map((f) => [f.rule, f.severity])).toEqual([
      ["js-exception", "high"],
      ["console-error", "medium"],
      ["request-failed", "low"],
    ]);
    const ex = r.findings[0]!;
    expect(ex.occurrences).toBe(3);
    expect(ex.evidence).toEqual(["3× on 2 pages", `at render (${U}/app.js:10:5)`]);
    expect(r.counts).toEqual({ high: 1, medium: 1, low: 1 });
  });

  it("drops the console echo of a document that answered 4xx, keeps other failed loads", () => {
    const r = analyzeScan(
      fakeReport([fakePage(`${U}/gone`, undefined, { statusCode: 404 }), fakePage(`${U}/`)], [], {
        errorClusters: [
          cluster("console", "Failed to load resource: the server responded with a status of 404", [`${U}/gone`]),
          cluster("console", "Failed to load resource: net::ERR_FAILED", [`${U}/`]),
        ],
      }),
    );
    expect(r.findings.map((f) => [f.rule, f.where])).toEqual([
      ["broken-link", [`${U}/gone`]],
      ["console-error", [`${U}/`]],
    ]);
  });

  it("files axe violations under a11y", () => {
    const c = { ...cluster("invariant-violation", "color-contrast"), invariantNames: ["a11y-axe"] };
    const [f] = analyzeScan(fakeReport([], [], { errorClusters: [c] })).findings;
    expect([f!.rule, f!.category]).toEqual(["a11y-violation", "a11y"]);
  });
});

describe("analyzeScan: resilience", () => {
  const clean = fakeReport([fakePage(`${U}/`), fakePage(`${U}/list`)], [], {
    errorClusters: [cluster("console", "already there")],
  });

  it("reports errors that appear only under faults, minus the browser's echo of the fault", () => {
    const chaos = fakeReport(clean.pages, [], {
      errorClusters: [
        cluster("console", "already there"),
        cluster("console", "Failed to load resource: the server responded with a status of 500"),
        cluster("network", `${U}/api/items - net::ERR_FAILED`),
        cluster("unhandled-rejection", "SyntaxError: Unexpected token"),
        cluster("console", "render failed"),
      ],
    });
    const abort = fakeReport(clean.pages, [], { errorClusters: [cluster("unhandled-rejection", "SyntaxError: Unexpected token", [`${U}/list`], 2)] });
    const r = analyzeScan(clean, [
      { fault: "status", report: chaos },
      { fault: "abort", report: abort },
    ]);
    expect(r.findings.map((f) => [f.rule, f.severity, f.category])).toEqual([
      ["fault-new-error", "high", "resilience"],
      ["console-error", "medium", "bug"],
      // A console.error: the app caught the failure and logged it.
      ["fault-new-error", "low", "resilience"],
    ]);
    const merged = r.findings[0]!;
    expect(merged.occurrences).toBe(3);
    expect(merged.where).toEqual([`${U}/`, `${U}/list`]);
    expect(merged.evidence[0]).toBe("3× under HTTP 500, network failure; never in the clean crawl");
  });

  it("reports pages that load clean but break under faults", () => {
    const chaos = fakeReport([fakePage(`${U}/`), fakePage(`${U}/list`, undefined, { status: "timeout" })], []);
    const f = analyzeScan(clean, [{ fault: "hang", report: chaos }]).findings.find((x) => x.rule === "fault-page-broken")!;
    expect(f.where).toEqual([`${U}/list`]);
    expect(f.evidence).toEqual([`${U}/list: timeout under no response (loaded in the clean crawl)`]);
  });

  it("flags steps that waited out the hung request, not ones with a timeout or slow anyway", () => {
    const hangSpan = (key: string, o: { durationMs: number; settledMs?: number; capped?: boolean; unfinished?: boolean }) =>
      span(key, (s) => {
        s.durationMs = o.durationMs;
        s.capped = o.capped ?? false;
        s.faults = [SCAN_FAULT_NAMES.hang];
        if (o.settledMs !== undefined) s.network.settledMs = o.settledMs;
        if (o.unfinished) s.network.settledUnfinished = true;
      });
    const cleanRun = fakeReport(
      [fakePage(`${U}/`, span("/ :: load", (s) => (s.durationMs = 200)))],
      [
        fakeAction(span("/ :: click #save", (s) => (s.durationMs = 50))),
        fakeAction(span("/ :: click #ok", (s) => (s.durationMs = 50))),
        fakeAction(span("/ :: click #slow", (s) => (s.durationMs = 6000))),
      ],
    );
    const hang = fakeReport(
      [fakePage(`${U}/`, hangSpan("/ :: load", { durationMs: 8100 }))],
      [
        // The action's settle gave up at its cap with the request still open.
        fakeAction(hangSpan("/ :: click #save", { durationMs: 2000, capped: true, unfinished: true })),
        // Aborted by the app's own timeout after 1 s.
        fakeAction(hangSpan("/ :: click #ok", { durationMs: 40, settledMs: 1000 })),
        // Slow in the clean crawl too: not the hang's doing.
        fakeAction(hangSpan("/ :: click #slow", { durationMs: 8000 })),
        // Not under the hang at all.
        fakeAction(span("/ :: click #other", (s) => (s.durationMs = 9000))),
      ],
    );
    const runs = [{ fault: "hang" as const, report: hang }];
    const f = analyzeScan(cleanRun, runs, { hangReleaseMs: 8000 }).findings.find((x) => x.rule === "no-request-timeout")!;
    expect(f.where).toEqual(["/ :: load", "/ :: click #save"]);
    expect(f.patterns).toEqual(["hang-no-timeout"]);
    expect(f.evidence[1]).toMatch(/still waiting on the request/);
    expect(analyzeScan(cleanRun, runs).findings.some((x) => x.rule === "no-request-timeout")).toBe(false);
  });

  it("flags a step whose requests multiply under a fault (retry storm)", () => {
    const withRequests = (n: number) => span("/ :: load", (s) => (s.network.requestCount = n));
    const cleanRun = fakeReport([fakePage(`${U}/`, withRequests(3))], []);
    const storm = fakeReport([fakePage(`${U}/`, withRequests(40))], []);
    const mild = fakeReport([fakePage(`${U}/`, withRequests(9))], []);
    const f = analyzeScan(cleanRun, [
      { fault: "abort", report: mild },
      { fault: "status", report: storm },
    ]).findings.find((x) => x.rule === "fault-request-storm")!;
    expect(f.evidence).toEqual(["/ :: load: 40 requests under HTTP 500 (clean 3)"]);
    expect(analyzeScan(cleanRun, [{ fault: "abort", report: mild }]).findings).toEqual([]);
  });
});

describe("analyzeScan: perf", () => {
  it("grades Web Vitals by document against the good / poor bounds", () => {
    const r = analyzeScan(
      fakeReport(
        [
          fakePage(`${U}/`, undefined, { perfPage: perfPage({ vitals: { LCP: vital(4500), CLS: vital(0.05) } }) }),
          fakePage(`${U}/b`, undefined, {
            perfPage: perfPage({
              vitals: {},
              documents: [
                { url: `${U}/b`, timeOrigin: 0, vitals: { LCP: vital(2600) } },
                { url: `${U}/c`, timeOrigin: 1, vitals: { CLS: vital(0.12) } },
              ],
            }),
          }),
        ],
        [],
      ),
    );
    const lcp = r.findings.find((f) => f.rule === "vital-lcp")!;
    expect(lcp.severity).toBe("high");
    expect(lcp.where).toEqual([`${U}/`, `${U}/b`]);
    expect(lcp.patterns).toContain("late-discovered-lcp");
    const cls = r.findings.find((f) => f.rule === "vital-cls")!;
    expect([cls.severity, cls.where]).toEqual(["low", [`${U}/c`]]);
  });

  it("keeps the worst span per perfKey and grades by the poor bound", () => {
    const r = analyzeScan(
      fakeReport(
        [fakePage(`${U}/`, span("/ :: load", (s) => (s.cpu.blockingMs = 60)))],
        [
          fakeAction(span("/ :: click #a", (s) => (s.cpu.blockingMs = 120))),
          fakeAction(span("/ :: click #a", (s) => (s.cpu.blockingMs = 250))),
          fakeAction(span("/ :: click #b", (s) => (s.cpu.blockingMs = 10))),
        ],
      ),
    );
    const f = r.findings.find((x) => x.rule === "span-blocking")!;
    expect(f.severity).toBe("high");
    expect(f.where).toEqual(["/ :: click #a", "/ :: load"]);
    expect(f.evidence[0]).toMatch(/^\/ :: click #a: 250ms blocking/);
  });

  it("counts requests only on actions for chatty-action, and waves only on loads", () => {
    const r = analyzeScan(
      fakeReport(
        [fakePage(`${U}/`, span("/ :: load", (s) => ((s.network.requestCount = 90), (s.network.waves = 5))))],
        [fakeAction(span("/ :: input #q", (s) => (s.network.requestCount = 20)))],
      ),
    );
    expect(r.findings.find((f) => f.rule === "chatty-action")!.where).toEqual(["/ :: input #q"]);
    expect(r.findings.find((f) => f.rule === "request-waterfall")!.where).toEqual(["/ :: load"]);
  });

  it("reads layout, style, DOM size, frames and slow requests off spans", () => {
    const s = span("/ :: click #go", (x) => {
      x.render.layoutCount = SCAN_THRESHOLDS.layoutCount.warn;
      x.render.recalcStyleMs = SCAN_THRESHOLDS.recalcStyleMs.poor;
      x.memory = { ...x.memory, domNodes: SCAN_THRESHOLDS.domNodes.warn };
      x.frames = { count: 60, droppedFrames: 12, longestFrameMs: 120, fps: 40 };
      x.network.requests = [
        { url: `${U}/api/big?page=1`, type: "Fetch", startOffsetMs: 0, durationMs: 3500, kb: 900, thirdParty: false },
      ];
    });
    const r = analyzeScan(fakeReport([fakePage(`${U}/`)], [fakeAction(s)]));
    expect(rules(r).sort()).toEqual(["dom-size", "dropped-frames", "heavy-resource", "slow-request", "span-layout", "span-style"]);
    expect(r.findings.find((f) => f.rule === "span-style")!.severity).toBe("high");
    expect(r.findings.find((f) => f.rule === "slow-request")!.where).toEqual([`${U}/api/big`]);
  });

  it("reports page weight, render-blocking resources, images and compression", () => {
    const page = fakePage(`${U}/`, undefined, {
      perfPage: perfPage({
        network: { totalRequests: 50, totalEncodedKB: 5000, fromCacheCount: 0, thirdParty: { requestCount: 31, encodedKB: 900 } },
        renderBlocking: { stylesheets: 1, scripts: 2, urls: ["/a.css", "/b.js", "/c.js"] },
        media: {
          imageCount: 3,
          imageKB: 2000,
          oversizedCount: 1,
          oversized: [{ url: "/hero.jpg", overFetch: 9, kb: 1500 }],
          uncompressedCount: 1,
          uncompressed: [{ url: "/app.js", kb: 400, ratio: 1 }],
        },
      }),
    });
    const r = analyzeScan(fakeReport([page], []));
    expect(rules(r).sort()).toEqual(["oversized-image", "page-weight", "render-blocking", "third-party-heavy", "uncompressed-text"]);
    expect(r.findings.find((f) => f.rule === "page-weight")!.severity).toBe("high");
  });

  it("reports leaks, pages that never idle, and unused JS", () => {
    const r = analyzeScan(
      fakeReport([fakePage(`${U}/`, undefined, { settleCapped: 2 })], [], {
        perf: {
          vitals: {},
          slowestActions: [],
          hotInitiators: [],
          thirdParty: [],
          totals: { spans: 0, pages: 0 },
          trends: [
            { name: "/ :: click #open", count: 4, metric: "domNodes", values: [100, 600, 1100, 1600], growth: 1500, perStep: 500, monotonic: true, leak: true },
            { name: "/ :: click #x", count: 4, metric: "domNodes", values: [1, 2, 1, 2], growth: 1, perStep: 0.3, monotonic: false, leak: false },
          ],
          coverage: {
            js: { totalBytes: 800 * 1024, usedBytes: 100 * 1024, usedPct: 12.5, lowUsage: [{ url: "/vendor.js", totalBytes: 700 * 1024, usedBytes: 20 * 1024, usedPct: 2.9 }] },
            css: { totalBytes: 0, usedBytes: 0, lowUsage: [] },
          },
        },
      }),
    );
    expect(rules(r)).toEqual(["memory-leak", "unused-js", "never-idle"]);
    expect(r.findings[0]!.where).toEqual(["/ :: click #open"]);
    expect(r.findings[1]!.severity).toBe("medium");
  });

  it("finds duplicate requests, per-item fan-out and heavy responses in a step's requests", () => {
    const req = (url: string, o: { type?: string; kb?: number } = {}) => ({
      url,
      type: o.type ?? "Fetch",
      startOffsetMs: 0,
      durationMs: 10,
      kb: o.kb ?? 1,
      thirdParty: false,
    });
    const load = span("/ :: load", (s) => {
      s.network.requests = [
        req(`${U}/api/user`),
        req(`${U}/api/user`),
        req(`${U}/api/user`),
        ...[1, 2, 3, 4, 5, 6].map((i) => req(`${U}/api/posts/${i}/author`)),
        req(`${U}/font.ttf`, { type: "Font", kb: 1100 }),
      ];
    });
    const r = analyzeScan(fakeReport([fakePage(`${U}/`, load)], []));
    expect(r.findings.find((f) => f.rule === "duplicate-request")!.evidence).toEqual([`/ :: load: ${U}/api/user requested 3×`]);
    expect(r.findings.find((f) => f.rule === "per-item-requests")!.evidence).toEqual([`/ :: load: 6 requests to ${U}/api/posts/:id/author`]);
    expect(r.findings.find((f) => f.rule === "heavy-resource")!.where).toEqual([`${U}/font.ttf`]);
  });

  it("finds static files downloaded again on several page loads, not cached ones", () => {
    const load = (path: string, kb: number) =>
      span(`${path} :: load`, (s) => {
        s.network.requests = [
          { url: `${U}/app.js?v=${path}`, type: "Script", startOffsetMs: 0, durationMs: 5, kb, thirdParty: false },
          { url: `${U}/cached.css`, type: "Stylesheet", startOffsetMs: 0, durationMs: 1, kb: 0, thirdParty: false },
        ];
      });
    const pages = ["/a", "/b", "/c"].map((p) => fakePage(`${U}${p}`, load(p, 90)));
    const f = analyzeScan(fakeReport(pages, [])).findings.find((x) => x.rule === "repeat-download")!;
    expect(f.where).toEqual([`${U}/app.js`]);
    expect(f.evidence).toEqual([`${U}/app.js: downloaded again on 3 page loads (90 KB)`]);
  });

  it("reads slow actions, listeners and heap growth; renders-blocking needs a script or 3 stylesheets", () => {
    const click = span("/ :: click #sync", (s) => {
      s.durationMs = 30;
      s.network.settledMs = 780;
      s.memory = { ...s.memory, jsEventListeners: 2500, jsHeapDeltaMB: 12, jsHeapUsedMB: 40 };
    });
    const two = fakePage(`${U}/`, undefined, { perfPage: perfPage({ renderBlocking: { stylesheets: 2, scripts: 0, urls: ["/a.css", "/b.css"] } }) });
    const r = analyzeScan(fakeReport([two], [fakeAction(click)]));
    expect(rules(r).sort()).toEqual(["heap-growth", "many-listeners", "slow-action"]);
    expect(r.findings.find((f) => f.rule === "slow-action")!.evidence).toEqual(["/ :: click #sync: 780ms until its work finished (span 30ms)"]);
    expect(r.findings.find((f) => f.rule === "many-listeners")!.severity).toBe("high");
  });

  it("grades third-party weight by bytes as well as requests", () => {
    const page = fakePage(`${U}/`, undefined, {
      perfPage: perfPage({ network: { totalRequests: 20, totalEncodedKB: 900, fromCacheCount: 0, thirdParty: { requestCount: 12, encodedKB: 800 } } }),
    });
    const f = analyzeScan(fakeReport([page], [])).findings.find((x) => x.rule === "third-party-heavy")!;
    expect([f.severity, f.patterns]).toEqual(["medium", [...RULE_PATTERNS["third-party-heavy"]!]]);
  });

  it("caps where to SCAN_WHERE_CAP but counts every occurrence", () => {
    const pages = Array.from({ length: 8 }, (_, i) =>
      fakePage(`${U}/p${i}`, undefined, { perfPage: perfPage({ vitals: { TTFB: vital(900 + i) } }) }),
    );
    const f = analyzeScan(fakeReport(pages, [])).findings[0]!;
    expect(f.rule).toBe("vital-ttfb");
    expect(f.where).toHaveLength(SCAN_WHERE_CAP);
    expect(f.where[0]).toBe(`${U}/p7`);
    expect(f.occurrences).toBe(8);
  });

  it("finds nothing on a clean, fast crawl", () => {
    const r = analyzeScan(
      fakeReport([fakePage(`${U}/`, fakeSpan("/ :: load"), { perfPage: perfPage({ vitals: { LCP: vital(800) } }) })], [fakeAction(fakeSpan("/ :: click #a"))]),
    );
    expect(r.findings).toEqual([]);
  });
});

describe("analyzeScan: false positives seen on real sites", () => {
  it("leaves the scan's own network failures out of findings and notes them once", () => {
    const report = fakeReport([fakePage(`${U}/`)], [], {
      errorClusters: [
        cluster("network", "https://logx.optimizely.com/v1/events - net::ERR_TUNNEL_CONNECTION_FAILED", [`${U}/`], 40),
        cluster("console", "Failed to load resource: net::ERR_TUNNEL_CONNECTION_FAILED", [`${U}/`], 40),
        cluster("network", "https://www.youtube.com/embed/x - net::ERR_BLOCKED_BY_CLIENT", [`${U}/`], 2),
        cluster("network", "https://www.google-analytics.com/g/collect?v=2 - net::ERR_ABORTED", [`${U}/`], 1),
        cluster("exception", "TypeError: real bug"),
      ],
    });
    const r = analyzeScan(report, [{ fault: "status", report }]);
    expect(rules(r)).toEqual(["js-exception"]);
    expect(r.environment).toEqual([
      { code: "net::ERR_TUNNEL_CONNECTION_FAILED", reason: expect.stringContaining("proxy"), count: 80, hosts: ["logx.optimizely.com"] },
      { code: "net::ERR_BLOCKED_BY_CLIENT", reason: expect.stringContaining("guard"), count: 2, hosts: ["www.youtube.com"] },
      { code: "net::ERR_ABORTED", reason: expect.stringContaining("cancelled"), count: 1, hosts: ["www.google-analytics.com"] },
    ]);
  });

  it("notes an untrusted certificate issuer and undecodable media, and flags knock-on fetch errors", () => {
    const pg = `${U}/playground`;
    const report = fakeReport([fakePage(pg), fakePage(`${U}/`)], [], {
      errorClusters: [
        cluster("network", "https://registry.npmjs.org/svelte.tgz - net::ERR_CERT_AUTHORITY_INVALID", [pg], 4),
        cluster("unhandled-rejection", "NotSupportedError: The element has no supported sources.", [`${U}/`]),
        cluster("exception", "TypeError: Failed to fetch", [pg], 10),
        cluster("exception", "TypeError: Failed to fetch", [`${U}/`], 1),
      ].map((c, i) => (i === 3 ? { ...c, key: "exception|other" } : c)),
    });
    const r = analyzeScan(report);
    expect(r.environment.map((e) => [e.code, e.count])).toEqual([
      ["net::ERR_CERT_AUTHORITY_INVALID", 4],
      ["media: no supported source", 1],
    ]);
    const [onEnvPage, elsewhere] = r.findings;
    expect([onEnvPage!.rule, onEnvPage!.where]).toEqual(["js-exception", [pg]]);
    expect(onEnvPage!.evidence.at(-1)).toMatch(/knock-on effect/);
    expect(elsewhere!.evidence.some((e) => /knock-on/.test(e))).toBe(false);
  });

  it("does not call a step that never requested the endpoint when it worked a retry storm", () => {
    const withRequests = (n: number) =>
      span("/ :: load", (s) => {
        s.network.requestCount = n;
        s.network.requests = Array.from({ length: n }, () => ({ url: `${U}/api/x`, type: "Fetch", startOffsetMs: 0, durationMs: 1, kb: 1, thirdParty: false }));
      });
    const cleanRun = fakeReport([fakePage(`${U}/`, withRequests(0))], []);
    const hangRun = fakeReport([fakePage(`${U}/`, withRequests(12))], []);
    expect(analyzeScan(cleanRun, [{ fault: "hang", report: hangRun }], { endpointPattern: "/api/x" }).findings).toEqual([]);
  });

  it("caps revalidation-only repeat downloads at medium and leaves third-party files out", () => {
    const load = (path: string, q: { url: string; kb: number; thirdParty?: boolean }) =>
      span(`${path} :: load`, (s) => {
        s.network.requests = [{ url: q.url, type: "Stylesheet", startOffsetMs: 0, durationMs: 5, kb: q.kb, thirdParty: q.thirdParty ?? false }];
      });
    const paths = Array.from({ length: 12 }, (_, i) => `/p${i}`);
    const reval = analyzeScan(fakeReport(paths.map((p) => fakePage(`${U}${p}`, load(p, { url: `${U}/main.css`, kb: 0.3 }))), []));
    expect(reval.findings.map((f) => [f.rule, f.severity])).toEqual([["repeat-download", "medium"]]);
    const full = analyzeScan(fakeReport(paths.map((p) => fakePage(`${U}${p}`, load(p, { url: `${U}/main.css`, kb: 40 }))), []));
    expect(full.findings.map((f) => [f.rule, f.severity])).toEqual([["repeat-download", "high"]]);
    // Downloaded once, then a 304 on every later page (htmx.org's
    // max-age=0, must-revalidate): revalidations, not re-downloads.
    const once = analyzeScan(
      fakeReport(paths.map((p, i) => fakePage(`${U}${p}`, load(p, { url: `${U}/bars.png`, kb: i === 0 ? 9.3 : 0.4 }))), []),
    );
    expect(once.findings.map((f) => [f.rule, f.severity])).toEqual([["repeat-download", "medium"]]);
    expect(once.findings[0]!.evidence).toEqual([
      `${U}/bars.png: downloaded once (9.3 KB), then revalidated (not reused from cache) on 11 page loads`,
    ]);
    const ads = paths.map((p) => fakePage(`${U}${p}`, load(p, { url: "https://ads.example/consent.js", kb: 70, thirdParty: true })));
    expect(analyzeScan(fakeReport(ads, [])).findings).toEqual([]);
  });

  it("leaves the crawler's own navigation errors to the page rules", () => {
    const goto = cluster("exception", "page.goto: Timeout 30000ms exceeded.\nCall log: navigating to ...", [`${U}/slow`]);
    const clean = fakeReport([fakePage(`${U}/slow`)], []);
    const chaos = fakeReport([fakePage(`${U}/slow`, undefined, { status: "timeout" })], [], { errorClusters: [goto] });
    expect(rules(analyzeScan(fakeReport([fakePage(`${U}/slow`, undefined, { status: "timeout" })], [], { errorClusters: [goto] })))).toEqual([
      "page-load-failed",
    ]);
    expect(rules(analyzeScan(clean, [{ fault: "hang", report: chaos }]))).toEqual(["fault-page-broken"]);
  });

  it("does not blame a fault for a page whose measured load it never touched", () => {
    const clean = fakeReport([fakePage(`${U}/doc`)], []);
    const untouched = fakeReport([fakePage(`${U}/doc`, fakeSpan("/doc :: load"), { status: "timeout" })], []);
    expect(analyzeScan(clean, [{ fault: "hang", report: untouched }]).findings).toEqual([]);
    const hit = fakeReport([fakePage(`${U}/doc`, fakeSpan("/doc :: load", { faults: [SCAN_FAULT_NAMES.hang] }), { status: "timeout" })], []);
    expect(rules(analyzeScan(clean, [{ fault: "hang", report: hit }]))).toEqual(["fault-page-broken"]);
  });

  it("counts only requests to the failing endpoints as a retry storm, not a full-page fallback", () => {
    const withRequests = (urls: string[]) =>
      span("/a :: click #nav", (s) => {
        s.network.requestCount = urls.length;
        s.network.requests = urls.map((url) => ({ url, type: "Fetch", startOffsetMs: 0, durationMs: 1, kb: 1, thirdParty: false }));
      });
    const api = `${U}/api/data.json`;
    const cleanRun = fakeReport([], [fakeAction(withRequests([api]))]);
    // The router gave up on the data request and loaded the page in full.
    const fallback = fakeReport([], [fakeAction(withRequests([api, ...Array.from({ length: 19 }, (_, i) => `${U}/chunk${i}.js`)]))]);
    const storm = fakeReport([], [fakeAction(withRequests(Array.from({ length: 15 }, () => api)))]);
    const endpointPattern = "^http://localhost:3000/api/data\\.json$";
    expect(analyzeScan(cleanRun, [{ fault: "status", report: fallback }], { endpointPattern }).findings).toEqual([]);
    const f = analyzeScan(cleanRun, [{ fault: "status", report: storm }], { endpointPattern }).findings[0]!;
    expect([f.rule, f.evidence]).toEqual(["fault-request-storm", ["/a :: click #nav: 15 requests to the failing endpoints under HTTP 500 (clean 1)"]]);
  });

  it("does not count a load waiting on a request it started after its content painted", () => {
    const hungLoad = (startOffsetMs: number) =>
      span("/ :: load", (s) => {
        s.durationMs = 8100;
        s.faults = [SCAN_FAULT_NAMES.hang];
        s.network.requests = [{ url: `${U}/api/prefetch`, type: "Fetch", startOffsetMs, durationMs: 8000, kb: 0, thirdParty: false }];
      });
    const cleanRun = fakeReport([fakePage(`${U}/`, span("/ :: load", (s) => (s.durationMs = 900)))], []);
    const hangRun = (startOffsetMs: number) =>
      fakeReport([fakePage(`${U}/`, hungLoad(startOffsetMs), { perfPage: perfPage({ vitals: { LCP: vital(700) } }) })], []);
    const opts = { hangReleaseMs: 8000, endpointPattern: "/api/" };
    // Started at 1.5 s, after the 0.7 s LCP: a prefetch; the page was up.
    expect(analyzeScan(cleanRun, [{ fault: "hang", report: hangRun(1500) }], opts).findings).toEqual([]);
    // Started at 50 ms, before anything painted: the page was waiting on it.
    expect(rules(analyzeScan(cleanRun, [{ fault: "hang", report: hangRun(50) }], opts))).toEqual(["no-request-timeout"]);
    // No LCP reported: the first paint stands in for it.
    const fcpOnly = fakeReport([fakePage(`${U}/`, hungLoad(1500), { perfPage: perfPage({ vitals: { FCP: vital(600) } }) })], []);
    expect(analyzeScan(cleanRun, [{ fault: "hang", report: fcpOnly }], opts).findings).toEqual([]);
  });

  it("does not grade a client-side route change as a chatty action or its heap as growth", () => {
    const route = span("/ :: click a#docs", (s) => {
      s.network.requestCount = 30;
      s.memory = { ...s.memory, jsHeapDeltaMB: 20 };
    });
    const stay = span("/ :: click #more", (s) => (s.network.requestCount = 30));
    const r = analyzeScan(fakeReport([], [{ ...fakeAction(route), urlChanged: true }, fakeAction(stay)]));
    expect(r.findings.map((f) => [f.rule, f.where])).toEqual([["chatty-action", ["/ :: click #more"]]]);
  });

  it("does not grade a click that navigated as a chatty or slow action", () => {
    const nav = span("/ :: click a#next", (s) => {
      s.navigations = 1;
      s.durationMs = 2600;
      s.network.requestCount = 40;
    });
    const capped = span("/ :: scroll", (s) => {
      s.capped = true;
      s.durationMs = 2000;
    });
    expect(analyzeScan(fakeReport([], [fakeAction(nav), fakeAction(capped)])).findings).toEqual([]);
  });

  it("ignores repeated third-party beacons and cache hits as duplicates", () => {
    const req = (url: string, o: { kb?: number; thirdParty?: boolean } = {}) => ({
      url,
      type: "XHR",
      startOffsetMs: 0,
      durationMs: 1,
      kb: o.kb ?? 1,
      thirdParty: o.thirdParty ?? false,
    });
    const s = span("/ :: click #go", (x) => {
      x.network.requests = [
        req("https://log.tracker.example/event?a=1", { thirdParty: true }),
        req("https://log.tracker.example/event?a=1", { thirdParty: true }),
        req(`${U}/api/me`),
        req(`${U}/api/me`, { kb: 0 }),
      ];
    });
    expect(analyzeScan(fakeReport([], [fakeAction(s)])).findings).toEqual([]);
  });

  it("tells files on one image-service path apart when they are revalidated", () => {
    const load = (path: string, img: string) =>
      span(`${path} :: load`, (s) => {
        s.network.requests = [
          { url: `${U}/_next/image?url=${img}`, type: "Image", startOffsetMs: 0, durationMs: 5, kb: 0.2, thirdParty: false },
        ];
      });
    const distinct = ["/a", "/b", "/c"].map((p, i) => fakePage(`${U}${p}`, load(p, `img${i}.png`)));
    expect(analyzeScan(fakeReport(distinct, [])).findings).toEqual([]);
    const same = ["/a", "/b", "/c"].map((p) => fakePage(`${U}${p}`, load(p, "logo.png")));
    const f = analyzeScan(fakeReport(same, [])).findings[0]!;
    expect(f.evidence).toEqual([`${U}/_next/image?url=logo.png: revalidated (not reused from cache) on 3 page loads (0.2 KB)`]);
  });
});

describe("analyzeScan: false positives seen on a third round of sites", () => {
  it("rates a 401 / 403 resource error low, and a third-party script's rejection medium", () => {
    const ad = {
      ...cluster("unhandled-rejection", "No ad placements found.", [`${U}/`, `${U}/jobs`], 22),
      sample: {
        type: "unhandled-rejection" as const,
        message: "No ad placements found.",
        timestamp: 0,
        stack: "Error: No ad placements found.\n    at w (https://media.ethicalads.io/media/client/v1.4.0/ethicalads.min.js:1:11867)",
      },
    };
    const own = cluster("unhandled-rejection", "TypeError: x is undefined");
    const r = analyzeScan(
      fakeReport([fakePage(`${U}/`, undefined, { links: [`${U}/jobs`] }), fakePage(`${U}/jobs`)], [], {
        errorClusters: [cluster("console", "Failed to load resource: the server responded with a status of 401 (Unauthorized)"), ad, own],
      }),
    );
    expect(r.findings.map((f) => [f.title.slice(0, 40), f.severity])).toEqual([
      ["Unhandled promise rejection: TypeError: ", "high"],
      ["Unhandled promise rejection: No ad place", "medium"],
      ["console.error: Failed to load resource: ", "low"],
    ]);
    expect(r.findings[1]!.evidence.at(-1)).toMatch(/third-party script \(media\.ethicalads\.io\)/);
  });

  it("keys repeat downloads by URL without cache-busting parameters", () => {
    expect(assetIdentity("https://x.test/app.js?v=1727712000000")).toBe("https://x.test/app.js");
    expect(assetIdentity("https://x.test/app.js?_=abc&cb=1#h")).toBe("https://x.test/app.js");
    expect(assetIdentity("https://x.test/_next/image?url=%2Fa.png&w=64&q=75")).toBe("https://x.test/_next/image?url=%2Fa.png&w=64&q=75");
    // Twelve thumbnails of the same size from one image service are twelve files.
    const paths = Array.from({ length: 12 }, (_, i) => `/p${i}`);
    const pages = paths.map((p, i) =>
      fakePage(
        `${U}${p}`,
        span(`${p} :: load`, (s) => {
          s.network.requests = [{ url: `${U}/_next/image?url=%2Fimg${i}.png&w=64`, type: "Image", startOffsetMs: 0, durationMs: 5, kb: 1.4, thirdParty: false }];
        }),
      ),
    );
    expect(analyzeScan(fakeReport(pages, [])).findings).toEqual([]);
  });
});

describe("analyzeScan: false positives seen on a fourth round of sites", () => {
  it("ignores the vitals of a document on another origin", () => {
    const page = fakePage(`${U}/wiki/A`, undefined, {
      perfPage: perfPage({
        documents: [
          { url: `${U}/wiki/A`, timeOrigin: 0, vitals: { TTFB: vital(100) } },
          { url: "https://auth.example.org/CreateAccount", timeOrigin: 1, vitals: { TTFB: vital(2500), CLS: vital(0.4) } },
        ],
      }),
    });
    expect(analyzeScan(fakeReport([page, fakePage(`${U}/wiki/B`)], [])).findings).toEqual([]);
  });

  it("warns about a one-page crawl whose only links are to itself or other sites", () => {
    const start = fakePage(`${U}/`, undefined, {
      links: [`${U}/`, `${U}/#canvas`, "https://github.com/x/y"],
      perfPage: perfPage({ network: { totalRequests: 40, totalEncodedKB: 3000, fromCacheCount: 0 } }),
    });
    const w = analyzeScan(fakeReport([start], [])).coverageWarnings;
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/single-page app/);
  });
});

describe("analyzeScan: coverage warnings", () => {
  it("says so when the crawl barely reached the site, and not otherwise", () => {
    const tiny = fakePage(`${U}/`, undefined, {
      perfPage: perfPage({ network: { totalRequests: 3, totalEncodedKB: 15, fromCacheCount: 0 } }),
    });
    const w = analyzeScan(fakeReport([tiny], [])).coverageWarnings;
    expect(w).toHaveLength(2);
    expect(w[0]).toMatch(/only the start page/);
    expect(w[1]).toMatch(/nearly empty \(3 requests, 15 KB\)/);

    const normal = fakePage(`${U}/`, undefined, {
      links: [`${U}/a`],
      perfPage: perfPage({ network: { totalRequests: 40, totalEncodedKB: 900, fromCacheCount: 0 } }),
    });
    expect(analyzeScan(fakeReport([normal, fakePage(`${U}/a`)], [])).coverageWarnings).toEqual([]);
    expect(formatScanSummary(analyzeScan(fakeReport([tiny], [])))).toMatch(/⚠️ {2}The crawl reached only/);
  });
});

describe("RULE_PATTERNS", () => {
  it("names only patterns that exist in the catalog", () => {
    const dir = join(__dirname, "..", "..", "..", "..", "examples", "perf-patterns", "src", "patterns");
    const missing = Object.values(RULE_PATTERNS)
      .flat()
      .filter((name) => !existsSync(join(dir, `${name}.ts`)));
    expect(missing).toEqual([]);
  });
});

describe("withSidecarRequests", () => {
  const req = (url: string) => ({ url, type: "Fetch", startOffsetMs: 0, durationMs: 1, kb: 1, thirdParty: false });

  it("puts each key's full list back in crawl order, keeping the report's list when it is longer", () => {
    const load = fakeSpan("/ :: load");
    load.network.requests = [req("a")];
    const c1 = fakeSpan("/ :: click #a");
    const c2 = fakeSpan("/ :: click #a");
    c2.network.requests = [req("x"), req("y")];
    const report = fakeReport([fakePage(`${U}/`, load)], [fakeAction(c1), fakeAction(c2)]);
    const out = withSidecarRequests(report, [
      { key: "/ :: load", requests: [req("a"), req("b")] },
      { key: "/ :: click #a", requests: [req("first")] },
      { key: "/ :: click #a", requests: [req("x")] },
    ]);
    expect(out.pages[0]!.perf!.network.requests.map((r) => r.url)).toEqual(["a", "b"]);
    expect(out.actions.map((a) => a.perf!.network.requests.map((r) => r.url))).toEqual([["first"], ["x", "y"]]);
    expect(report.pages[0]!.perf!.network.requests).toHaveLength(1);
  });
});

describe("deriveScanEndpoints", () => {
  const req = (url: string, type = "Fetch", thirdParty = false) => ({ url, type, startOffsetMs: 0, durationMs: 1, kb: 1, thirdParty });

  it("keeps same-site fetch / XHR, folds ids, and ranks by count", () => {
    const load = fakeSpan("/ :: load");
    load.network.requests = [
      req(`${U}/api/items?page=2`),
      req(`${U}/api/items/42`, "XHR"),
      req(`${U}/api/items/43`),
      req(`${U}/app.js`, "Script"),
      req("https://analytics.example/collect", "Fetch", true),
    ];
    load.network.requests.push(req(`${U}/api/items`));
    const eps = deriveScanEndpoints(fakeReport([fakePage(`${U}/`, load)], []));
    expect(eps.map((e) => [e.label, e.count])).toEqual([
      [`${U}/api/items`, 2],
      [`${U}/api/items/:id`, 2],
    ]);
    const re = new RegExp(endpointsPattern(eps)!);
    expect(re.test(`${U}/api/items?x=1`)).toBe(true);
    expect(re.test(`${U}/api/items/999`)).toBe(true);
    expect(re.test(`${U}/api/items/999/comments`)).toBe(false);
    expect(re.test(`${U}/api/itemsX`)).toBe(false);
    expect(re.test(`${U}/`)).toBe(false);
  });

  it("leaves out the site's own page URLs (data fetched from the route's URL)", () => {
    const load = fakeSpan("/ :: load");
    load.network.requests = [req(`${U}/blog?_rsc=abc`), req(`${U}/?_rsc=def`), req(`${U}/api/session`)];
    const report = fakeReport([fakePage(`${U}/`, load), fakePage(`${U}/blog`)], []);
    expect(deriveScanEndpoints(report).map((e) => e.label)).toEqual([`${U}/api/session`]);
  });

  it("leaves out the pages the crawled ones link to (a router prefetching them)", () => {
    const load = fakeSpan("/ :: load");
    load.network.requests = [req(`${U}/docs/z-index?_rsc=1`), req(`${U}/docs/clear?_rsc=2`), req(`${U}/api/session`)];
    const page = { ...fakePage(`${U}/`, load), links: [`${U}/docs/z-index`, `${U}/docs/clear`] };
    expect(deriveScanEndpoints(fakeReport([page], [])).map((e) => e.label)).toEqual([`${U}/api/session`]);
  });

  it("leaves out excluded URLs", () => {
    const load = fakeSpan("/ :: load");
    load.network.requests = [req(`${U}/plus/login?_rsc=1`), req(`${U}/api/session`)];
    const report = fakeReport([fakePage(`${U}/`, load)], []);
    expect(deriveScanEndpoints(report, { exclude: ["login"] }).map((e) => e.label)).toEqual([`${U}/api/session`]);
  });

  it("leaves out static files a page fetches (CSS chunks, WebAssembly, models)", () => {
    const load = fakeSpan("/ :: load");
    load.network.requests = [
      req(`${U}/_next/static/css/3a23b2.css`),
      req(`${U}/_nuxt/onig.wasm`),
      req(`${U}/models/car.glb`),
      req(`${U}/api/items.json`),
    ];
    expect(deriveScanEndpoints(fakeReport([fakePage(`${U}/`, load)], [])).map((e) => e.label)).toEqual([`${U}/api/items.json`]);
  });

  it("leaves out paths a CDN or host injects", () => {
    const load = fakeSpan("/ :: load");
    load.network.requests = [req(`${U}/cdn-cgi/rum?x=1`), req(`${U}/_vercel/insights/view`), req(`${U}/api/me`)];
    expect(deriveScanEndpoints(fakeReport([fakePage(`${U}/`, load)], [])).map((e) => e.label)).toEqual([`${U}/api/me`]);
  });

  it("returns no pattern when there is no endpoint", () => {
    expect(endpointsPattern(deriveScanEndpoints(fakeReport([], [])))).toBeNull();
  });
});

describe("format", () => {
  it("writes a table, a section per finding and catalog links", () => {
    const report = fakeReport([fakePage(`${U}/`, undefined, { links: [`${U}/a`] })], [], { errorClusters: [cluster("exception", "boom | pipe")] });
    const analysis = analyzeScan(report);
    const md = formatScanMarkdown(analysis, {
      url: U,
      startedAt: "2026-09-30T00:00:00.000Z",
      durationMs: 12_000,
      pagesVisited: 1,
      actions: 0,
      files: { baseline: "out/clean-report.json", chaos: {}, perfDir: "out/perf" },
    });
    expect(md).toContain("# chaosbringer scan: http://localhost:3000");
    expect(md).toContain("Chaos crawls: off");
    expect(md).toContain("| 🔴 | bug | [Uncaught exception: boom \\| pipe](#f1) |");
    expect(md).toContain('<a id="f1"></a>');
    expect(formatScanSummary(analysis)).toBe(
      `scan: 1 findings (1 high, 0 medium, 0 low)\n  🔴 [bug] Uncaught exception: boom | pipe — ${U}/`,
    );

    const perf = analyzeScan(fakeReport([fakePage(`${U}/`, span("/ :: load", (s) => (s.cpu.blockingMs = 300)))], []));
    const md2 = formatScanMarkdown(perf, {
      url: U,
      startedAt: "",
      durationMs: 0,
      pagesVisited: 1,
      actions: 0,
      chaos: { runs: [], endpoints: [] },
      files: { baseline: "a", chaos: {}, perfDir: "b" },
    });
    expect(md2).toContain("[long-task-click](https://github.com/mizchi/chaosbringer/blob/main/examples/perf-patterns/src/patterns/long-task-click.ts)");
    expect(md2).toContain("Chaos crawls: skipped");
  });
});

describe("parseFaults", () => {
  it("maps 500 to the status crawl, dedupes, and refuses unknown or empty lists", () => {
    expect(parseFaults("500, hang,500")).toEqual(["status", "hang"]);
    expect(() => parseFaults("500,timeout")).toThrow(/unknown fault "timeout"/);
    expect(() => parseFaults(" , ")).toThrow(/at least one/);
  });
});
