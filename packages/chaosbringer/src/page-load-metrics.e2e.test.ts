import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "./crawler.js";
import type { CrawlerOptions, CrawlReport, PageResult } from "./types.js";

/**
 * LCP and TBT used to be declared, budgetable and advertised, and never
 * measured: `collectMetrics` read Navigation and Paint Timing only, so a
 * `--budget lcp=…` or `tbt=…` could not fire. They now come from the
 * lightbringer collector the crawler installs on every page.
 *
 * A browser is the only honest test of this. LCP exists only once Chromium
 * reports a candidate, and a long task only once the main thread really
 * blocks; a hand-built metrics object would test the budget check, which
 * `budget.test.ts` already does.
 */

/**
 * Visible text, then a ~200 ms busy loop that starts after the first paint.
 * TBT counts long tasks from FCP on, so a loop in a parser-blocking script
 * (which runs before anything is painted) would count for nothing. The loop
 * spins on `Date.now()`; under the clock-skew test that clock is shifted by a
 * constant, so the loop still burns the same wall time.
 */
const BUSY = `<!doctype html><title>busy</title><body>
  <h1>A heading large enough to be the LCP element</h1>
  <p>Some paragraph text so the page paints content.</p>
  <script>
    requestAnimationFrame(() => setTimeout(() => {
      const t0 = Date.now();
      while (Date.now() - t0 < 200) {}
    }, 50));
  </script>
</body>`;

const QUIET = `<!doctype html><title>quiet</title><body>
  <h1>Nothing blocks here</h1>
</body>`;

const PAGES: Record<string, string> = { "/busy": BUSY, "/quiet": QUIET };

const SKEW_MS = 60 * 60 * 1000;

describe("page-load LCP / TBT from the always-on collector", () => {
  let server: http.Server;
  let origin: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const body = PAGES[req.url ?? ""];
      if (!body) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      res.end(body);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** Crawl exactly one page with no chaos actions, so only the load is measured. */
  async function crawlOne(path: string, extra: Partial<CrawlerOptions> = {}): Promise<CrawlReport> {
    return new ChaosCrawler({
      baseUrl: `${origin}${path}`,
      maxPages: 1,
      maxActionsPerPage: 0,
      headless: true,
      timeout: 10_000,
      logLevel: "silent",
      ...extra,
    }).start();
  }

  const budgetViolations = (page: PageResult) =>
    page.errors.filter((e) => e.type === "invariant-violation").map((e) => e.invariantName);

  it("measures TBT from a busy loop after FCP, and a tbt budget fires", async () => {
    const report = await crawlOne("/busy", { performanceBudget: { tbt: 50 } });
    const page = report.pages[0];
    expect(page.metrics?.tbt).toBeGreaterThanOrEqual(100);
    // 200 ms of blocking is 150 ms of TBT; far more means a task was counted twice.
    expect(page.metrics?.tbt).toBeLessThan(1_000);
    expect(budgetViolations(page)).toContain("perf-budget.tbt");
  });

  it("measures LCP on a page with visible content, and an lcp budget fires", async () => {
    const report = await crawlOne("/quiet", { performanceBudget: { lcp: 1 } });
    const page = report.pages[0];
    expect(page.metrics?.lcp).toBeGreaterThan(0);
    expect(budgetViolations(page)).toEqual(["perf-budget.lcp"]);
    // The summary average is a real value now, not the 0 of "never measured".
    expect(report.summary.avgMetrics?.lcp).toBeGreaterThan(0);
  });

  it("reports TBT 0 — measured, not absent — when nothing blocks", async () => {
    const report = await crawlOne("/quiet");
    const page = report.pages[0];
    expect(page.metrics?.tbt).toBe(0);
    expect(typeof page.metrics?.lcp).toBe("number");
    expect(page.metrics?.ttfb).toBeGreaterThanOrEqual(0);
    expect(page.metrics?.fcp).toBeGreaterThan(0);
    // No perf session ran: the collector alone adds nothing to the result.
    expect(page).not.toHaveProperty("perf");
  });

  it("keeps LCP / TBT sane under a +1h clock-skew fault (collector installed first)", async () => {
    let collectorOffset: number | undefined;
    let pageOffset: number | undefined;
    const report = await crawlOne("/busy", {
      runtimeFaults: [{ action: { kind: "clock-skew", skewMs: SKEW_MS } }],
      invariants: [
        {
          name: "collector-clock",
          when: "afterLoad",
          async check({ page }) {
            const t = await page.evaluate(() => {
              // biome-ignore lint/suspicious/noExplicitAny: the collector's in-page store
              const perf = (window as any).__perf;
              return { collector: perf.now() as number, page: Date.now() };
            });
            const node = Date.now();
            collectorOffset = t.collector - node;
            pageOffset = t.page - node;
            return true;
          },
        },
      ],
    });
    const page = report.pages[0];
    // The fault really is active in page JS…
    expect(pageOffset).toBeGreaterThan(SKEW_MS - 60_000);
    // …and the collector still reads the real clock, which it can only do if
    // its init script ran before the runtime-fault script patched the clock.
    expect(Math.abs(collectorOffset ?? Number.POSITIVE_INFINITY)).toBeLessThan(60_000);
    expect(page.metrics?.lcp).toBeGreaterThan(0);
    expect(page.metrics?.lcp).toBeLessThan(60_000);
    expect(page.metrics?.tbt).toBeGreaterThanOrEqual(100);
    expect(page.metrics?.tbt).toBeLessThan(60_000);
  });

  it("leaves LCP / TBT absent on a caller-owned page without the collector", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const crawler = new ChaosCrawler({
        baseUrl: origin,
        maxActionsPerPage: 0,
        headless: true,
        timeout: 10_000,
        logLevel: "silent",
        performanceBudget: { lcp: 1, tbt: 1 },
      });
      const result = await crawler.testPage(page, `${origin}/busy`);
      expect(result.metrics?.fcp).toBeGreaterThan(0);
      expect(result.metrics).not.toHaveProperty("lcp");
      expect(result.metrics).not.toHaveProperty("tbt");
      // Absent metrics are not enforced, so neither budget can fire.
      expect(budgetViolations(result)).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
