import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { faults } from "@mizchi/playwright-faults";
import { chromium } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import type { CrawlerOptions } from "./types.js";

/**
 * The HTTP cache survives the crawl's default external-navigation blocking.
 *
 * Blocking used to go through `page.route("**\/*")` on every page, and
 * Playwright disables the browser cache on any page with a route — so every
 * page of every crawl was measured cold, whatever the site's caching headers
 * said. It is now a CDP guard on document requests only (`navigation-guard.ts`).
 * These count server hits for a cacheable asset shared by several pages, and
 * pin that blocking still blocks, and counts, on the paths that changed.
 */
describe("HTTP cache and external-navigation blocking", () => {
  let server: http.Server;
  let base: string;
  const hits = new Map<string, number>();
  const EXTERNAL = "http://external.invalid";

  const page = (body: string, next?: string) =>
    `<!doctype html><title>t</title><script src="/asset.js"></script>` +
    `<body>${body}${next ? `<a href="${next}">next</a>` : ""}</body>`;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0]!;
      hits.set(path, (hits.get(path) ?? 0) + 1);
      if (path === "/asset.js") {
        res.writeHead(200, { "content-type": "text/javascript", "cache-control": "max-age=3600" });
        res.end("window.assetLoaded = (window.assetLoaded || 0) + 1;");
        return;
      }
      if (path === "/api") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      const html: Record<string, string> = {
        "/": page("<p>one</p>", "/two"),
        "/two": page(`<iframe src="${EXTERNAL}/framed"></iframe>`, "/three"),
        "/three": page(`<script>fetch("/api")</script>`),
        // A same-origin sandboxed iframe runs out of process under site
        // isolation, so its own navigation is on its own CDP target.
        "/sandboxed": page(`<iframe sandbox="allow-scripts" src="/leaves"></iframe>`),
        "/leaves": `<script>setTimeout(() => { location.href = "${EXTERNAL}/from-oopif"; }, 50)</script>`,
      };
      res.writeHead(html[path] ? 200 : 404, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(html[path] ?? "missing");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => hits.clear());

  async function crawl(options: Partial<CrawlerOptions> = {}) {
    const blocked: string[] = [];
    const crawler = new ChaosCrawler(
      { baseUrl: base, maxPages: 3, maxActionsPerPage: 0, headless: true, timeout: 10_000, ...options },
      { onBlockedNavigation: (url) => blocked.push(url) },
    );
    const report = await crawler.start();
    return { report, blocked };
  }

  it("fetches a cacheable asset once across pages, and still blocks external navigation", async () => {
    const { report, blocked } = await crawl();
    expect(report.pagesVisited).toBe(3);
    expect(hits.get("/asset.js")).toBe(1);
    // The external iframe on /two is a subframe navigation, blocked and counted.
    expect(blocked).toEqual([`${EXTERNAL}/framed`]);
    expect(report.blockedExternalNavigations).toBe(1);
  }, 60_000);

  it("httpCache: false fetches it on every page", async () => {
    const { report, blocked } = await crawl({ httpCache: false });
    expect(report.pagesVisited).toBe(3);
    expect(hits.get("/asset.js")).toBe(3);
    expect(blocked).toEqual([`${EXTERNAL}/framed`]);
  }, 60_000);

  it("keeps the per-request route when faults are configured: faults apply, blocking too", async () => {
    const { report, blocked } = await crawl({
      faultInjection: [faults.status(500, { urlPattern: /\/api$/, name: "api-500" })],
    });
    expect(report.pagesVisited).toBe(3);
    const stats = report.faultInjections?.find((f) => f.rule === "api-500");
    expect(stats?.injected).toBe(1);
    // The fault answered the request: it never reached the server.
    expect(hits.get("/api")).toBeUndefined();
    expect(blocked).toEqual([`${EXTERNAL}/framed`]);
    // Every request goes through the route, and the route switches the cache off.
    expect(hits.get("/asset.js")).toBe(3);
  }, 60_000);

  it("blocks a navigation inside an out-of-process iframe", async () => {
    const { report, blocked } = await crawl({
      baseUrl: `${base}/sandboxed`,
      maxPages: 1,
      launchOptions: { args: ["--site-per-process"] },
    });
    expect(report.pagesVisited).toBe(1);
    expect(blocked).toEqual([`${EXTERNAL}/from-oopif`]);
  }, 60_000);

  it("releases the guard on a CDP-attached tab, which then navigates freely", async () => {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${port}`] });
    try {
      const context = await browser.newContext();
      const tab = await context.newPage();
      await tab.goto(base);
      const { report, blocked } = await crawl({ cdpEndpoint: `http://127.0.0.1:${port}`, maxPages: 2 });
      expect(report.pagesVisited).toBe(2);
      expect(blocked).toEqual([`${EXTERNAL}/framed`]);
      expect(tab.isClosed()).toBe(false);
      // `localhost` is another origin than the crawl's `127.0.0.1`: blocked during
      // the crawl, it has to load once the crawl is over.
      const other = base.replace("127.0.0.1", "localhost");
      const response = await tab.goto(other);
      expect(response?.status()).toBe(200);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
