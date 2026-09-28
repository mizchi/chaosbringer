import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import type { CrawlerOptions, CrawlReport } from "./types.js";

/**
 * Out-of-process iframes' traffic in a `--perf` crawl.
 *
 * Under site isolation (headed Chromium, a real Chrome over CDP,
 * `--site-per-process`) a cross-site iframe is its own CDP target, and the
 * page's session — the one lightbringer measures on — sees only the iframe's
 * document request, with 0 bytes. lightbringer now attaches to those targets
 * itself, so the load span counts the iframe's requests in every mode: the
 * same page must read the same numbers with and without site isolation.
 */

const KB = 1024;
// A comment is valid JS and CSS and is always fetched in full.
const blob = (kb: number) => Buffer.from(`/*${"a".repeat(kb * KB - 4)}*/`);
const SUB: Record<string, number> = { "/embed/app.js": 120, "/embed/style.css": 100, "/embed/data.json": 80 };
const EMBED_KB = 300;

describe("perf crawl counts out-of-process iframe traffic", () => {
  let server: http.Server;
  let base: string;
  let embed: string;
  const EXTERNAL = "http://external.invalid";

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0]!;
      const html = (body: string) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(`<!doctype html><meta charset=utf-8><title>t</title>${body}`);
      };
      if (path === "/") return html(`<h1>article</h1><iframe src="${embed}/embed"></iframe>`);
      // The page's own origin, sandboxed: out of process under site isolation,
      // and not an external navigation, so the navigation guard lets it load
      // and then guards it on its own target.
      if (path === "/sandboxed") return html(`<iframe sandbox="allow-scripts" src="/embed?leave=1"></iframe>`);
      if (path === "/embed") {
        const leave = (req.url ?? "").includes("leave=1")
          ? `<script>setTimeout(() => { location.href = "${EXTERNAL}/from-oopif"; }, 300)</script>`
          : "";
        return html(
          `<link rel=stylesheet href="/embed/style.css"><script src="/embed/app.js"></script>` +
            // the body is read: an unread response body stalls and never finishes
            `<script>fetch("/embed/data.json").then((r) => r.text())</script>${leave}`,
        );
      }
      const kb = SUB[path];
      if (!kb) {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = blob(kb);
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-length": body.length,
        "cache-control": "no-store",
        // the sandboxed iframe's origin is opaque: its fetch is cross-origin
        "access-control-allow-origin": "*",
      });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    // `localhost` is another site than `127.0.0.1`: a third-party embed.
    embed = `http://localhost:${port}`;
  }, 30_000);

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  function crawl(options: Partial<CrawlerOptions> = {}, blocked: string[] = []): Promise<CrawlReport> {
    return new ChaosCrawler(
      {
        baseUrl: `${base}/`,
        maxPages: 1,
        maxActionsPerPage: 0,
        headless: true,
        timeout: 10_000,
        logLevel: "silent",
        seed: 1,
        perf: {},
        // External-navigation blocking fails every cross-origin document
        // request, iframes included: the embed would never load.
        blockExternalNavigation: false,
        ...options,
      },
      { onBlockedNavigation: (url) => blocked.push(url) },
    ).start();
  }

  function expectEmbedCounted(report: CrawlReport): void {
    const page = report.pages[0]!;
    const load = page.perf!;
    // top document + iframe document + 3 subresources
    expect(load.network.requestCount).toBe(5);
    expect(load.network.thirdParty.requestCount).toBe(4);
    expect(load.network.thirdParty.encodedKB).toBeGreaterThanOrEqual(EMBED_KB);
    expect(load.network.thirdParty.encodedKB).toBeLessThan(EMBED_KB + 5);
    expect(page.perfPage!.network.totalRequests).toBe(5);
    expect(page.perfPage!.network.thirdParty!.encodedKB).toBeGreaterThanOrEqual(EMBED_KB);
  }

  it("in-process iframes (default headless)", async () => {
    expectEmbedCounted(await crawl());
  }, 60_000);

  it("out-of-process iframes (--site-per-process)", async () => {
    expectEmbedCounted(await crawl({ launchOptions: { args: ["--site-per-process"] } }));
  }, 60_000);

  it("an OOPIF that the navigation guard also attaches to: counted, and still guarded", async () => {
    const blocked: string[] = [];
    const report = await crawl(
      {
        baseUrl: `${base}/sandboxed`,
        blockExternalNavigation: true,
        launchOptions: { args: ["--site-per-process"] },
      },
      blocked,
    );
    expect(report.pagesVisited).toBe(1);
    expect(blocked).toEqual([`${EXTERNAL}/from-oopif`]);
    const load = report.pages[0]!.perf!;
    // top document + sandboxed iframe document + 3 subresources, all
    // first-party, + the iframe's blocked navigation
    expect(load.network.requestCount).toBe(6);
    expect(load.network.requests.map((r) => r.url)).toContain(`${EXTERNAL}/from-oopif`);
    expect(load.network.encodedKB).toBeGreaterThanOrEqual(EMBED_KB);
  }, 60_000);

  it("a Chromium attached over CDP with site isolation", async () => {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const browser = await chromium.launch({
      headless: true,
      args: [`--remote-debugging-port=${port}`, "--site-per-process"],
    });
    try {
      const context = await browser.newContext();
      const tab = await context.newPage();
      const report = await crawl({ cdpEndpoint: `http://127.0.0.1:${port}` });
      expectEmbedCounted(report);
      // The tab outlives the crawl; a new OOPIF in it must still load, with no
      // measurement session left holding new targets paused.
      await tab.goto(`${base}/`);
      const frame = tab.frames()[1]!;
      await frame.waitForLoadState("load");
      expect(await frame.evaluate(() => document.styleSheets.length)).toBe(1);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
