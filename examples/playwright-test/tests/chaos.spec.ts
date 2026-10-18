/**
 * chaosbringer inside a Playwright Test suite.
 *
 * Two patterns are demonstrated:
 *
 * 1. `chaosTest` — the fixture directly. Use this when chaos is the
 *    *primary* thing the file does.
 * 2. `withChaos()` — extend an existing `test`. Use this when you have
 *    a regular Playwright Test file and want chaos as one tool among
 *    many.
 *
 * URLs are relative: `chaos.testPage` / `chaos.crawl` resolve them against
 * `use.baseURL` in playwright.config.ts, as `page.goto` does.
 */

import { test as base, expect } from "@playwright/test";
import { chaosTest, withChaos, type ChaosFixtures } from "chaosbringer/fixture";
import { faults, type ChaosTestOptions } from "chaosbringer";

// Action selection during the crawl can click `<a href="/broken-link">`
// and Chromium logs the resulting 404 as a console error. That's correct
// HTML behaviour but not what we want the example to assert against —
// the third test exercises broken-link discovery via `expectNoDeadLinks`,
// which is a separate code path. Filter the resource-404 console message
// at the chaos level so the no-console-error test stays meaningful.
const COMMON_CHAOS_OPTIONS: ChaosTestOptions = {
  maxPages: 5,
  // chaosbringer treats these as regex source strings.
  ignoreErrorPatterns: ["Failed to load resource.*404"],
};

// ---------- pattern 1: chaosTest with per-file chaosOptions override ----------

chaosTest.use({ chaosOptions: COMMON_CHAOS_OPTIONS });

chaosTest("home page has no console errors", async ({ page, chaos }) => {
  const result = await chaos.testPage(page, "/");
  chaos.expectNoErrors(result);
});

chaosTest("crawl finds a broken link", async ({ chaos }) => {
  const report = await chaos.crawl("/");
  // Crawl visits at least the three reachable URLs (/, /about, /broken-link).
  expect(report.pagesVisited).toBeGreaterThanOrEqual(2);
  // /broken-link returns 404; the dead-link assertion should still catch it
  // — `expectNoDeadLinks` reads `summary.discovery.deadLinks`, not console
  // errors, so the `ignoreErrorPatterns` above does NOT mask it.
  expect(() => chaos.expectNoDeadLinks(report)).toThrow(/broken-link/);
});

// ---------- faults: break the API, assert the page copes ----------

chaosTest.describe("with the stock API down", () => {
  chaosTest.use({
    chaosOptions: {
      ...COMMON_CHAOS_OPTIONS,
      // Load-only: the assertions are about the page the fault landed on, not
      // wherever a random click would have taken it.
      maxActionsPerPage: 0,
      // Every request to /api/stock is answered 503 before it reaches the site.
      faultInjection: [faults.status(503, { urlPattern: /\/api\/stock$/ })],
      // Chromium logs the 503 as a console error. That is the fault itself,
      // not something the page did wrong.
      ignoreErrorPatterns: ["Failed to load resource.*(404|503)"],
      // Fail the test on anything else the CLI's `--strict` fails a run on —
      // a JS exception or an unhandled rejection from the failed fetch.
      strict: true,
    },
  });

  chaosTest("the stock page shows a fallback", async ({ page, chaos }) => {
    await chaos.testPage(page, "/stock");
    expect(chaos.crawler.getFaultStats()[0]?.injected).toBe(1);
    await expect(page.getByRole("status")).toHaveText("Stock unavailable");
  });
});

// ---------- pattern 2: withChaos extension ----------

const test = base.extend<ChaosFixtures>(withChaos(COMMON_CHAOS_OPTIONS));

test("about page shows the heading", async ({ page, chaos }) => {
  await page.goto("/about");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("About");

  // Plain Playwright assertions still work — chaos.* is an *addition*,
  // not a replacement. A single test can mix both.
  const result = await chaos.testPage(page, "/about");
  chaos.expectNoErrors(result);
});
