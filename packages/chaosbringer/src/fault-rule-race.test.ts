import http from "node:http";
import type { AddressInfo } from "node:net";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";

/**
 * Two rules watching one URL, and what the report says about the one that
 * lost. Both behaviours below were found by reading the diff rather than by a
 * failing test, and neither is visible from `matched`/`injected` alone — which
 * is why they are pinned here against a real browser rather than a fake route.
 */
describe("two fault rules on one URL", () => {
  let browser: Browser;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path.startsWith("/api/")) {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(`<!doctype html><title>race</title><body><div id="out">idle</div></body>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  /**
   * Issue requests from the page, in order, and report what each one got.
   * Driven from `page.evaluate` rather than on load so the requests are not
   * racing `networkidle`.
   */
  const statuses = (page: import("playwright").Page, calls: Array<[string, string]>) =>
    page.evaluate(async (cs: Array<[string, string]>) => {
      const out: string[] = [];
      for (const [method, url] of cs) {
        try {
          const r = await fetch(url, { method });
          out.push(String(r.status));
        } catch {
          out.push("threw");
        }
      }
      return out;
    }, calls);

  it("a /g-flagged urlPattern does not fire on every other request", async () => {
    // The rule the crawler tests against every request is one long-lived
    // RegExp. With `g`, `test()` leaves `lastIndex` behind, so the second GET
    // starts its search past the end of the first match and misses — the 503s
    // land on alternating calls, and `matched`/`injected` say 4/4 either way.
    // Nobody writing `/g` on a URL pattern is asking for that.
    const crawler = new ChaosCrawler({
      baseUrl: base,
      maxPages: 1,
      maxActionsPerPage: 0,
      headless: true,
      timeout: 5000,
      faultInjection: [
        {
          name: "postOnly",
          urlPattern: /\/api\/data/,
          methods: ["POST"],
          fault: { kind: "abort" },
        },
        { name: "gRule", urlPattern: /\/api\/data/g, fault: { kind: "status", status: 503 } },
      ],
    });
    const page = await browser.newPage();
    try {
      await crawler.testPage(page, base + "/");
      const seen = await statuses(page, [
        ["POST", "/api/data"],
        ["GET", "/api/data"],
        ["GET", "/api/data"],
        ["GET", "/api/data"],
        ["GET", "/api/data"],
      ]);
      expect(seen).toEqual(["threw", "503", "503", "503", "503"]);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("reports a scheduled rule that decided inject and lost the race", async () => {
    // `matched: 3, injected: 0` is what an all-`pass` schedule reports too.
    // A rule whose occurrence 0 said inject, and which lost to a rule ahead of
    // it, is a planned fault that did not happen — worth a number of its own,
    // because a model comparing plan to report otherwise reads "nothing was
    // planned here".
    const crawler = new ChaosCrawler({
      baseUrl: base,
      maxPages: 1,
      maxActionsPerPage: 0,
      headless: true,
      timeout: 5000,
      faultInjection: [
        {
          name: "first",
          urlPattern: /\/api\/race/,
          fault: { kind: "status", status: 500 },
          schedule: { decisions: ["inject", "inject", "pass"] },
        },
        {
          name: "second",
          urlPattern: /\/api\/race/,
          fault: { kind: "status", status: 502 },
          schedule: { decisions: ["inject", "pass"] },
        },
      ],
    });
    const page = await browser.newPage();
    try {
      await crawler.testPage(page, base + "/");
      const seen = await statuses(page, [
        ["GET", "/api/race"],
        ["GET", "/api/race"],
        ["GET", "/api/race"],
      ]);
      expect(seen).toEqual(["500", "500", "200"]);
      const stats = crawler.getFaultStats();
      expect(stats).toEqual([
        { rule: "first", matched: 3, injected: 2 },
        // Occurrence still advanced three times — two rules on one URL must
        // agree on what occurrence 1 means — and the one decision it could
        // not act on is named.
        { rule: "second", matched: 3, injected: 0, suppressed: 1 },
      ]);
    } finally {
      await page.close();
    }
  }, 60_000);
});
