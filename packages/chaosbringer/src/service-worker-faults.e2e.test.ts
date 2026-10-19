import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { faults } from "@mizchi/playwright-faults";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import { faultWarnings, unfiredFaults } from "./firings.js";
import { startTestServer, type TestServer } from "./test-server.test-helpers.js";
import type { CrawlReport, Invariant } from "./types.js";

/**
 * Network faults on a page a service worker controls.
 *
 * A request the worker's `fetch` handler takes never reaches the page's
 * route: what goes to the network is the worker's own request, which
 * Playwright hands to the context's routes only. Every rule on a PWA matched
 * nothing, the server answered every request, the run had no errors, and the
 * run-end warning said the pattern was wrong.
 *
 * The worker here forwards `/api/*` to the network and leaves the rest
 * alone, so the page's own document and the worker script are fetched as
 * they would be without it.
 */

// Registers the worker on the first visit and waits for it to claim the
// page, so the fetch below goes through it on every visit.
const PAGE = `<!doctype html><title>sw</title><body><p id="out">pending</p><a href="/next">next</a><script>
(async () => {
  if (!navigator.serviceWorker.controller) {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }));
  }
  window.__fetching = true;
  let text;
  try {
    const r = await fetch("/api/data");
    text = "api " + r.status + " " + (await r.text());
  } catch (e) {
    text = "api failed";
  }
  document.getElementById("out").textContent = text;
})();
</script></body>`;

// When its forwarded request fails, the worker says so to the server on a
// request of its own, which no rule here matches.
const WORKER = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const path = new URL(e.request.url).pathname;
  if (!path.startsWith("/api/")) return;
  e.respondWith(fetch(e.request).catch((err) => {
    fetch("/sw-report?failed=" + encodeURIComponent(path));
    throw err;
  }));
});`;

/** Waits for the page's fetch to settle and records what it showed. */
function shown(into: string[]): Invariant {
  return {
    name: "fetched",
    when: "afterLoad",
    urlPattern: /\/$/,
    check: async ({ page }) => {
      await page.waitForFunction(() => document.getElementById("out")?.textContent !== "pending", null, {
        timeout: 10_000,
      });
      into.push((await page.textContent("#out")) ?? "");
      return true;
    },
  };
}

async function shownOn(page: Page): Promise<string> {
  await page.waitForFunction(() => document.getElementById("out")?.textContent !== "pending", null, {
    timeout: 10_000,
  });
  return (await page.textContent("#out")) ?? "";
}

describe("network faults behind a service worker", () => {
  let server: TestServer;
  let base: string;
  let apiHits = 0;
  let reports: string[] = [];
  let dir: string;

  beforeAll(async () => {
    server = await startTestServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (path === "/sw.js") {
        res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
        res.end(WORKER);
        return;
      }
      if (path === "/api/data") {
        apiHits++;
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("live");
        return;
      }
      if (path === "/sw-report") {
        reports.push(req.url ?? "");
        res.writeHead(204);
        res.end();
        return;
      }
      if (path === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(path === "/" ? PAGE : `<!doctype html><title>next</title><p>next</p>`);
    });
    base = server.url;
    dir = mkdtempSync(join(tmpdir(), "cb-sw-"));
  }, 60_000);

  afterAll(async () => {
    await server?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    apiHits = 0;
    reports = [];
  });

  it("injects into the request the worker forwards, and counts it", async () => {
    const seen: string[] = [];
    const report = await new ChaosCrawler({
      baseUrl: base,
      maxPages: 1,
      maxActionsPerPage: 0,
      timeout: 10_000,
      faultInjection: [faults.status(503, { urlPattern: /\/api\/data/, body: "injected", name: "api-down" })],
      invariants: [shown(seen)],
    }).start();

    // Before: matched 0, the page showed "api 200 live", and the server was hit.
    expect(seen).toEqual(["api 503 injected"]);
    expect(report.faultInjections).toEqual([{ rule: "api-down", matched: 1, injected: 1 }]);
    expect(apiHits).toBe(0);
    expect(report.pages[0]?.serviceWorker).toBe("routed");
  }, 60_000);

  it("releases an unbounded hang on the worker's request with the page", async () => {
    // The worker's request is parked on the context's route, not the page's.
    // It is aborted when the crawl is done with the page that made it, which
    // the worker reports from the second page.
    const report = await new ChaosCrawler({
      baseUrl: base,
      maxPages: 2,
      maxActionsPerPage: 0,
      timeout: 4_000,
      settle: "adaptive",
      faultInjection: [faults.hang({ urlPattern: /\/api\/data/, name: "api-hangs" })],
      invariants: [
        {
          name: "worker-saw-the-abort",
          when: "afterLoad",
          urlPattern: /\/next$/,
          check: async () => {
            const until = Date.now() + 5_000;
            while (reports.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
            return reports.length > 0 || "the worker's held request was never released";
          },
        },
      ],
    }).start();

    expect(report.heldRequests).toBe(1);
    expect(report.faultInjections).toEqual([{ rule: "api-hangs", matched: 1, injected: 1 }]);
    expect(report.pages.map((p) => p.url)).toEqual([`${base}/`, `${base}/next`]);
    expect(report.pages.flatMap((p) => p.errors.filter((e) => e.type === "invariant-violation"))).toEqual([]);
    expect(reports).toEqual(["/sw-report?failed=%2Fapi%2Fdata"]);
    expect(apiHits).toBe(0);
  }, 60_000);

  describe("with --har-replay", () => {
    let har: string;

    beforeAll(() => {
      // Only the worker's request is in the HAR: the page and the worker
      // script fall through to the network (`notFound: "fallback"`).
      har = join(dir, "api.har");
      writeFileSync(
        har,
        JSON.stringify({
          log: {
            version: "1.2",
            creator: { name: "test", version: "1" },
            entries: [
              {
                startedDateTime: new Date(0).toISOString(),
                time: 1,
                request: {
                  method: "GET",
                  url: `${base}/api/data`,
                  httpVersion: "HTTP/1.1",
                  headers: [],
                  queryString: [],
                  cookies: [],
                  headersSize: -1,
                  bodySize: 0,
                },
                response: {
                  status: 200,
                  statusText: "OK",
                  httpVersion: "HTTP/1.1",
                  headers: [{ name: "content-type", value: "text/plain" }],
                  cookies: [],
                  content: { size: 8, mimeType: "text/plain", text: "from-har" },
                  redirectURL: "",
                  headersSize: -1,
                  bodySize: 8,
                },
                cache: {},
                timings: { send: 0, wait: 1, receive: 0 },
              },
            ],
          },
        }),
      );
    });

    it("lets the fault win over the HAR, as it does for the page's own requests", async () => {
      const seen: string[] = [];
      const report = await new ChaosCrawler({
        baseUrl: base,
        maxPages: 1,
        maxActionsPerPage: 0,
        timeout: 10_000,
        har: { mode: "replay", path: har },
        faultInjection: [faults.status(503, { urlPattern: /\/api\/data/, body: "injected", name: "api-down" })],
        invariants: [shown(seen)],
      }).start();

      expect(seen).toEqual(["api 503 injected"]);
      expect(report.faultInjections).toEqual([{ rule: "api-down", matched: 1, injected: 1 }]);
    }, 60_000);

    it("hands the HAR a worker's request no rule claims", async () => {
      const seen: string[] = [];
      const report = await new ChaosCrawler({
        baseUrl: base,
        maxPages: 1,
        maxActionsPerPage: 0,
        timeout: 10_000,
        har: { mode: "replay", path: har },
        faultInjection: [faults.status(503, { urlPattern: /\/elsewhere/, name: "unrelated" })],
        invariants: [shown(seen)],
      }).start();

      expect(seen).toEqual(["api 200 from-har"]);
      expect(apiHits).toBe(0);
      expect(report.faultInjections).toEqual([{ rule: "unrelated", matched: 0, injected: 0 }]);
    }, 60_000);
  });

  describe("testPage() on a page in the caller's context", () => {
    let browser: Browser;

    beforeAll(async () => {
      browser = await chromium.launch();
    }, 60_000);

    afterAll(async () => {
      await browser?.close();
    });

    it("leaves the context alone, and says the worker is why nothing matched", async () => {
      const context = await browser.newContext();
      try {
        // Install the worker first, as the app would have on an earlier visit.
        const page = await context.newPage();
        await page.goto(`${base}/`);
        expect(await shownOn(page)).toBe("api 200 live");

        const seen: string[] = [];
        const crawler = new ChaosCrawler({
          baseUrl: base,
          maxActionsPerPage: 0,
          timeout: 10_000,
          faultInjection: [faults.status(503, { urlPattern: /\/api\/data/, name: "api-down" })],
          invariants: [shown(seen)],
        });
        const result = await crawler.testPage(page, `${base}/`);

        // The context is the caller's, so the crawler puts no route on it:
        // the worker's request goes out untouched.
        expect(seen).toEqual(["api 200 live"]);
        expect(crawler.getFaultStats()).toEqual([{ rule: "api-down", matched: 0, injected: 0 }]);
        expect(result.serviceWorker).toBe("unrouted");

        // Before, this said "the pattern did not see the request you expected".
        const partial = { faultInjections: crawler.getFaultStats(), pages: [result] } as CrawlReport;
        const [problem, ...rest] = unfiredFaults(partial);
        expect(rest).toEqual([]);
        expect(problem).toContain('network fault "api-down" never matched anything');
        expect(problem).toContain("a service worker controlled 1 page(s)");
        expect(problem).not.toContain("the pattern did not see");
        expect(faultWarnings(partial)).toEqual([
          {
            event: "fault_rule_unmatched",
            data: { rule: "api-down", layer: "network", matched: 0, serviceWorker: { reach: "unrouted", pages: 1 } },
          },
        ]);

        // And nothing of the crawler's is left on the context.
        const other = await context.newPage();
        await other.goto(`${base}/`);
        expect(await shownOn(other)).toBe("api 200 live");
      } finally {
        await context.close();
      }
    }, 60_000);
  });
});
