import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";

/**
 * `testPage()` runs on a page the caller owns, in a context `start()` never
 * set up. Runtime faults are init scripts that `start()` put on the crawl's
 * own context only, so on this path they silently never ran; and the
 * lifecycle executor stayed bound to the first page it was made for, so a
 * second `testPage()` applied its lifecycle faults to the previous page.
 */

// An uncaught fetch: a rejected one surfaces as an unhandled rejection. The
// iframe's `src` is assigned by script, which is where iframe faults act.
const PAGE = `<!doctype html><title>t</title><body>
  <script>fetch("/api/data").then((r) => r.text()).then((t) => { document.title = "ok:" + t; });</script>
  <script>const f = document.createElement("iframe"); f.className = "widget"; f.src = "/frame"; document.body.append(f);</script>
</body>`;

describe("testPage() on a caller's page", () => {
  let server: TestServer;
  let browser: Browser;

  beforeAll(async () => {
    server = await startTestServer((req, res) => {
      if (req.url === "/api/data") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("data");
        return;
      }
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(req.url === "/frame" ? "<!doctype html><p>frame</p>" : PAGE);
    });
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("injects its runtime faults", async () => {
    const crawler = new ChaosCrawler({
      baseUrl: server.url,
      maxActionsPerPage: 0,
      runtimeFaults: [{ urlPattern: "/api/data", action: { kind: "reject-fetch", rejectionMessage: "injected" } }],
    });
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const result = await crawler.testPage(page, `${server.url}/`);
      expect(result.errors.some((e) => e.type === "unhandled-rejection" && e.message.includes("injected"))).toBe(true);
      expect(await page.title()).not.toMatch(/^ok:/);
    } finally {
      await context.close();
    }
  }, 60_000);

  it("counts the runtime and iframe faults it injected", async () => {
    // They fired on this path, and every counter said they had not: the
    // in-page counters were read on the crawl's own pages only.
    const crawler = new ChaosCrawler({
      baseUrl: server.url,
      maxActionsPerPage: 0,
      runtimeFaults: [
        { name: "api-rejects", urlPattern: "/api/data", action: { kind: "reject-fetch", rejectionMessage: "injected" } },
      ],
      iframeFaults: [{ name: "widget-blank", selector: "iframe.widget", action: { kind: "never-load" } }],
    });
    const context = await browser.newContext();
    try {
      await crawler.testPage(await context.newPage(), `${server.url}/`);
      expect(crawler.getRuntimeFaultStats()).toEqual([{ rule: "api-rejects", matched: 1, fired: 1 }]);
      expect(crawler.getIframeFaultStats()).toEqual([
        { rule: "widget-blank", selector: "iframe.widget", action: "never-load", matched: 1, fired: 1 },
      ]);
    } finally {
      await context.close();
    }
  }, 60_000);

  it("applies a second call's lifecycle faults to that call's page", async () => {
    const crawler = new ChaosCrawler({
      baseUrl: server.url,
      maxActionsPerPage: 0,
      lifecycleFaults: [
        { when: "afterLoad", action: { kind: "tamper-storage", scope: "localStorage", key: "k", value: "v" } },
      ],
    });
    // Two contexts, so the pages do not share one origin's localStorage.
    const first = await browser.newContext();
    const second = await browser.newContext();
    try {
      await crawler.testPage(await first.newPage(), `${server.url}/`);
      const page = await second.newPage();
      await crawler.testPage(page, `${server.url}/`);
      expect(await page.evaluate(() => localStorage.getItem("k"))).toBe("v");
    } finally {
      await first.close();
      await second.close();
    }
  }, 60_000);
});
