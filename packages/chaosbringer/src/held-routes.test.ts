import http from "node:http";
import type { AddressInfo } from "node:net";
import { faults } from "@mizchi/playwright-faults";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";

/**
 * A `hang` fault with no `releaseAfterMs` parks the route: the handler returns
 * without answering, so the request stays in flight and the app sits on a
 * promise that never settles. That is the fault's whole point — but somebody
 * has to abort it afterwards, or the app is left waiting past the run that
 * asked for it.
 *
 * `crawlPage` closes the page it owns and drains on the way out. `testPage`
 * does not own the page: it hands it back to the caller, so if it does not
 * release what it parked, the caller's next action on that page waits on a
 * request nothing will ever answer, and their `page.close()` races a live
 * route handler. These tests pin the release, because "the request is still
 * pending" is invisible from a PageResult — the symptom only shows up later,
 * in whatever the caller does next.
 */
describe("held routes are released to the caller", () => {
  let browser: Browser;
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/api/hang") {
        // Never answered by the origin either — the fault parks it before it
        // gets here, but if the route is ever released as `fallback()` rather
        // than `abort()` we would hang on the server instead of the route.
        return;
      }
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(`<!doctype html><title>held</title><body><div id="s">waiting</div>
<script>
  window.__settled = "pending";
  fetch("/api/hang")
    .then(() => { window.__settled = "answered"; })
    .catch(() => { window.__settled = "rejected"; });
</script></body>`);
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
   * The hang is on a request the page issues during navigation, so
   * `waitUntil: "networkidle"` cannot be reached and the goto spends one
   * `timeout`. That is the documented cost of hanging a load-time request,
   * and 1.5s of it is cheaper here than the machinery to click a button.
   */
  function crawler() {
    return new ChaosCrawler({
      baseUrl: base,
      maxPages: 1,
      maxActionsPerPage: 0,
      headless: true,
      timeout: 1500,
      faultInjection: [faults.hang({ urlPattern: /\/api\/hang/ })],
    });
  }

  const settled = (page: Page) => page.evaluate("window.__settled") as Promise<string>;

  it("releases the parked request before testPage returns", async () => {
    const page = await browser.newPage();
    try {
      await crawler().testPage(page, base + "/");
      // The abort reaches the page as a rejected fetch. If the route were
      // still parked this stays "pending" forever, which is what makes the
      // caller's next step wait on nothing.
      await page.waitForFunction('window.__settled !== "pending"', undefined, { timeout: 5000 });
      expect(await settled(page)).toBe("rejected");
    } finally {
      await page.close();
    }
  }, 60_000);

  it("survives the caller closing the page while a route is parked", async () => {
    // The shape a failing test takes: the fixture tears the page down while
    // the crawler is between parking and draining, so the drain runs against
    // routes whose page is already gone. This is a regression guard on the
    // outcome — the close resolves and the run resolves — not a proof of the
    // `.catch()` around the abort: on Chromium today, aborting a route whose
    // page has closed resolves rather than rejecting, so removing that catch
    // does not fail this test. The catch stays because whether a dead route
    // rejects is a driver detail, and a dead route must never be the thing
    // that fails somebody's run.
    const page = await browser.newPage();
    const run = crawler().testPage(page, base + "/");
    await page.waitForFunction('window.__settled === "pending"', undefined, { timeout: 5000 });
    await expect(page.close()).resolves.toBeUndefined();
    await expect(run).resolves.toBeDefined();
  }, 60_000);

  it("release() lets a caller drain without ending the run", async () => {
    const page = await browser.newPage();
    const c = crawler();
    try {
      const run = c.testPage(page, base + "/");
      await page.waitForFunction('window.__settled === "pending"', undefined, { timeout: 5000 });
      await c.release();
      await page.waitForFunction('window.__settled !== "pending"', undefined, { timeout: 5000 });
      expect(await settled(page)).toBe("rejected");
      await run;
    } finally {
      await page.close();
    }
  }, 60_000);
});
