import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { awaitPendingPaint, collectorInitScript } from "lightbringer/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import { faults } from "./faults.js";
import { noisePng, solidPng } from "./png.test-helpers.js";
import type { CrawlerOptions, CrawlReport, PageResult } from "./types.js";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";

/**
 * The wait for a paint the browser has drawn but not yet presented runs after
 * the load span, and only when the first read says a paint can still arrive.
 * A presentation stall needs the GPU process stopped
 * (paint-wait.stall.e2e.test.ts); these pin what a stall-free run can show:
 * pages that never paint and pages whose late image Chromium never counts
 * pay no wait, a pending paint that never comes costs a few frames outside
 * the span, and a budget on a metric that was not measured is said, never
 * failed.
 */

const H1 = `<h1 style="margin:0;padding:8px 16px;font:32px/1.2 system-ui">Sea view resort</h1>`;

/** Pages that paint nothing contentful: no FCP, and nothing to wait for. */
const NEVER_PAINT: Record<string, string> = {
  blank: `<body></body>`,
  "csrf-shell": `<body><form><input type="hidden" name="csrf" value="x"></form><div id="root"></div></body>`,
  sprite: `<body><svg style="display:none"><symbol id="i"><path d="M0 0h10v10z"/></symbol></svg><div id="root"></div></body>`,
  canvas: `<body><canvas width="300" height="150"></canvas></body>`,
  "skip-link": `<body><a href="#main" style="position:absolute;left:-9999px">Skip to content</a><div id="root"></div></body>`,
  "anti-flicker": `<body style="opacity:0"><h1>Hello</h1></body>`,
  "sr-only": `<style>.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style><body><span class="sr">Loading</span><div id="root"></div></body>`,
  "clip-circle": `<body><h1 style="clip-path:circle(0)">Hello world</h1></body>`,
  "clip-inset": `<body><h1 style="clip-path:inset(100%)">Hello world</h1></body>`,
};

/**
 * An image that loads after the text's LCP candidate, which Chromium does not
 * make the LCP: the first read sees a late image response, the check finds
 * nothing to wait for.
 */
const DECOYS: Record<string, string> = {
  "clipped-img": `<body style="margin:0">${H1}<div style="width:50px;height:50px;overflow:hidden"><img src="/img/noise400.png" width="400" height="400"></div></body>`,
  "icon-bg-px": `<body style="margin:0">${H1}<div style="width:600px;height:400px;background:url(/img/noise64.png) no-repeat;background-size:64px 64px"></div></body>`,
  "low-entropy-img": `<body style="margin:0">${H1}<img src="/img/solid600.png" width="600" height="600"></body>`,
  "below-fold-img": `<body style="margin:0">${H1}<div style="height:2000px"></div><img src="/img/noise400.png" width="400" height="400"></body>`,
  "opacity0-img": `<body style="margin:0">${H1}<div style="opacity:0"><img src="/img/noise400.png" width="400" height="400"></div></body>`,
  "full-viewport-bg": `<body style="margin:0"><div style="position:fixed;inset:0;background:url(/img/noise1400.png) center/cover"></div><div style="position:relative">${H1}</div></body>`,
  "upscaled-img": `<body style="margin:0">${H1}<img src="/img/noise20.png" width="400" height="400"></body>`,
};

const PAGES: Record<string, string> = {
  ...NEVER_PAINT,
  ...DECOYS,
  text: `<body>${H1}</body>`,
  // An <img> hero that loads after the text and becomes the LCP before the
  // load settles: read once, no wait.
  "late-hero": `<body style="margin:0">${H1}<img src="/img/noise400.png" width="400" height="400"></body>`,
  shadow: `<script>customElements.define("my-el", class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<h1 style='font:32px system-ui'>Hello from a shadow root</h1>"; } });</script><body><my-el></my-el></body>`,
  // Visible only once a request the crawl hangs answers: the settle caps.
  capped: `<style>body{opacity:0}</style><body><h1>Hello</h1><script>fetch("/api/slow").then(()=>{document.body.style.opacity=1})</script></body>`,
  // Visible from the start, with a request the crawl hangs: the settle caps,
  // and with the paint entries hidden a wait would find the text pending.
  "capped-visible": `<body>${H1}<script>fetch("/api/slow")</script></body>`,
  // For the input latch: a button to click while the image is in flight.
  input: `<body style="margin:0"><h1 style="margin:0;font:32px system-ui">Sea view</h1><button id="b">ok</button><img src="/img/noise400.png?slow" width="400" height="400"></body>`,
};

const IMAGES: Record<string, Buffer> = {
  "noise400.png": noisePng(400, 3),
  "noise64.png": noisePng(64, 5),
  "noise20.png": noisePng(20, 7),
  "noise1400.png": noisePng(1400, 9),
  "solid600.png": solidPng(600),
};

/** Hides the paint entries from page script, so FCP reads as never presented. */
const HIDE_PAINT = `(() => {
  const orig = performance.getEntriesByType.bind(performance);
  performance.getEntriesByType = (t) => (t === "paint" ? [] : orig(t));
})();`;

describe("the load path's wait for a paint not yet presented", () => {
  let server: TestServer;
  let origin: string;
  // The pages the next crawl's sitemap lists.
  let sitemap: string[] = [];

  beforeAll(async () => {
    server = await startTestServer((req, res) => {
      const url = req.url ?? "/";
      const image = /^\/img\/([^?]+)(\?slow)?$/.exec(url);
      if (image && IMAGES[image[1]!]) {
        const body = IMAGES[image[1]!]!;
        // Late enough that the heading's text is the LCP candidate first.
        setTimeout(() => {
          res.writeHead(200, { "content-type": "image/png", "content-length": body.length, "cache-control": "no-store" });
          res.end(body);
        }, image[2] ? 400 : 150);
        return;
      }
      if (url === "/api/slow") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (url === "/sitemap.xml") {
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(
          `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sitemap
            .map((p) => `<url><loc>${server.url}/p/${p}</loc></url>`)
            .join("")}</urlset>`,
        );
        return;
      }
      const page = /^\/p\/([^/?]+)/.exec(url);
      const body = page ? PAGES[page[1]!] : url === "/" ? PAGES.text : undefined;
      res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(body ? `<!doctype html><title>t</title>${body}` : "not found");
    });
    origin = server.url;
  });
  afterAll(async () => {
    await server.close();
  });

  const base: Partial<CrawlerOptions> = {
    maxActionsPerPage: 0,
    headless: true,
    timeout: 10_000,
    logLevel: "error",
    settle: "adaptive",
    perf: true,
  };

  /** Crawl `pages` in one browser (sitemap-seeded), keyed by page name. */
  async function crawlPages(pages: string[], extra: Partial<CrawlerOptions> = {}): Promise<Record<string, PageResult>> {
    sitemap = pages;
    const report: CrawlReport = await new ChaosCrawler({
      ...base,
      baseUrl: `${origin}/p/${pages[0]}`,
      seedFromSitemap: `${origin}/sitemap.xml`,
      maxPages: pages.length,
      ...extra,
    }).start();
    const out: Record<string, PageResult> = {};
    for (const p of report.pages) {
      const name = /\/p\/([^/?]+)/.exec(p.url)?.[1];
      if (name) out[name] = p;
    }
    expect(Object.keys(out).sort()).toEqual([...pages].sort());
    return out;
  }

  async function crawlOne(page: string, extra: Partial<CrawlerOptions> = {}): Promise<PageResult> {
    return (await crawlPages([page], extra))[page]!;
  }

  const violations = (p: PageResult) => p.errors.filter((e) => e.type === "invariant-violation");

  for (const perf of [true, false]) {
    it(`does not wait on pages that never paint contentfully, and says their FCP budget went unmeasured (perf ${perf ? "on" : "off"})`, async () => {
      const results = await crawlPages(Object.keys(NEVER_PAINT), { perf, performanceBudget: { fcp: 1000 } });
      for (const [name, page] of Object.entries(results)) {
        expect(page.metrics?.fcp, name).toBeUndefined();
        expect(page, name).not.toHaveProperty("paintWait");
        expect(violations(page), name).toEqual([]);
        expect(page.budgetUnmeasured, name).toEqual([
          { metric: "fcp", reason: "no-content", message: "the page showed no contentful content" },
        ]);
      }
    }, 60_000);
  }

  it("does not wait on a text page, nor on a late <img> hero that became LCP before the load settled", async () => {
    const results = await crawlPages(["text", "late-hero"], { performanceBudget: { fcp: 5000, lcp: 5000 } });
    for (const [name, page] of Object.entries(results)) {
      expect(page.metrics?.fcp, name).toBeGreaterThan(0);
      expect(page, name).not.toHaveProperty("paintWait");
      expect(page, name).not.toHaveProperty("budgetUnmeasured");
    }
    expect(results["late-hero"]!.metrics!.lcp).toBeGreaterThan(results["late-hero"]!.metrics!.fcp!);
  }, 60_000);

  it("does not wait on late images Chromium does not make the LCP", async () => {
    // The solid image is under Chromium's 0.05 bits per pixel at 600x600.
    expect((IMAGES["solid600.png"]!.length * 8) / (600 * 600)).toBeLessThan(0.05);
    const results = await crawlPages(Object.keys(DECOYS));
    for (const [name, page] of Object.entries(results)) {
      expect(page.metrics?.lcp, name).toBeGreaterThan(0);
      // The heading stayed the LCP: a decoy Chromium did count would make
      // this test pass without the check ever judging it.
      expect(page.perfPage?.vitals.LCP?.value, name).toBeGreaterThan(0);
      expect(page.perfPage?.vitals.LCP?.attribution?.url, name).toBeUndefined();
      expect(page, name).not.toHaveProperty("paintWait");
    }
  }, 60_000);

  it("bounds a pending FCP that never comes to a few frames, outside the load span", async () => {
    const clean = await crawlPages(["text"]);
    const outDir = mkdtempSync(join(tmpdir(), "cb-paint-wait-"));
    let forced: Record<string, PageResult>;
    let sidecar: Record<string, unknown>;
    try {
      forced = await crawlPages(["text", "shadow"], {
        initScripts: [HIDE_PAINT],
        performanceBudget: { fcp: 5000 },
        perf: { outDir },
      });
      sidecar = JSON.parse(readFileSync(join(outDir, forced.text!.perfPage!.reportPath!), "utf8"));
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
    const page = forced.text!;
    // The crawler waited; lightbringer's finish() did not wait again (its
    // report, the sidecar, would then carry a paintWait of its own).
    expect(sidecar).not.toHaveProperty("paintWait");
    expect(page.metrics?.fcp).toBeUndefined();
    expect(page.paintWait).toMatchObject({ outcome: "frames", pending: ["fcp"], stillPending: ["fcp"], content: "text" });
    // The baseline frame, then at most 8 more.
    expect(page.paintWait!.frames).toBeLessThanOrEqual(9);
    expect(page.paintWait!.waitedMs).toBeLessThan(300);
    // The span closed before the wait: it is no longer than a clean load's.
    expect(page.perf!.durationMs).toBeLessThan(clean.text!.perf!.durationMs + 50);
    expect(page.budgetUnmeasured).toEqual([
      {
        metric: "fcp",
        reason: "not-presented",
        message: `content was visible but no first contentful paint was reported within ${page.paintWait!.frames} frames`,
      },
    ]);
    expect(violations(page)).toEqual([]);
    // Text only in an open shadow root still counts as content.
    expect(forced.shadow!.paintWait).toMatchObject({ outcome: "frames", pending: ["fcp"], content: "text" });
  }, 60_000);

  it("does not wait after a capped load settle, and says the budget was not awaited", async () => {
    const page = await crawlOne("capped", {
      timeout: 3000,
      faultInjection: [faults.hang({ urlPattern: "/api/slow" })],
      performanceBudget: { fcp: 1000, lcp: 1000 },
    });
    expect(page.settleCapped).toBe(1);
    expect(page.perf!.capped).toBe(true);
    expect(page).not.toHaveProperty("paintWait");
    expect(page.budgetUnmeasured?.map((u) => [u.metric, u.reason])).toEqual([
      ["fcp", "capped"],
      ["lcp", "capped"],
    ]);
    expect(violations(page)).toEqual([]);
  }, 60_000);

  it("does not wait after a capped load settle even with a paint pending", async () => {
    const page = await crawlOne("capped-visible", {
      timeout: 3000,
      initScripts: [HIDE_PAINT],
      faultInjection: [faults.hang({ urlPattern: "/api/slow" })],
      performanceBudget: { fcp: 1000 },
    });
    expect(page.settleCapped).toBe(1);
    // A wait that ignored the cap would record outcome "frames" here.
    expect(page).not.toHaveProperty("paintWait");
    expect(page.budgetUnmeasured?.map((u) => [u.metric, u.reason])).toEqual([["fcp", "capped"]]);
  }, 60_000);

  it("does not wait for an image LCP after the first input: Chromium reports no candidate then", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.addInitScript({ content: collectorInitScript() });
      await page.goto(`${origin}/p/input`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(100);
      await page.click("#b");
      // The image is served 400 ms in: by now it has loaded and painted, as
      // a larger image than the heading, after the click.
      await page.waitForLoadState("load");
      await page.waitForTimeout(400);
      const r = await awaitPendingPaint(page);
      expect(r.outcome).toBe("none");
      expect(r.initial).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
