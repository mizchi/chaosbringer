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
 */

import { test as base, expect } from "@playwright/test";
import { chaosTest, withChaos, type ChaosFixtures } from "chaosbringer/fixture";

// chaos.testPage / chaos.crawl require absolute URLs (the crawler computes
// `new URL(url).origin` to gate external-navigation blocking). Pin the
// fixture port here so the demo stays single-source for the whole stack;
// playwright.config.ts and site/server.mjs read the same env.
const BASE = `http://localhost:${process.env.PORT ?? 3300}`;

// ---------- pattern 1: chaosTest ----------

chaosTest("home page has no console errors", async ({ page, chaos }) => {
  const result = await chaos.testPage(page, `${BASE}/`);
  chaos.expectNoErrors(result);
});

chaosTest("crawl finds a broken link", async ({ chaos }) => {
  const report = await chaos.crawl(`${BASE}/`);
  // Crawl visits at least the three reachable URLs (/, /about, /broken-link).
  expect(report.pagesVisited).toBeGreaterThanOrEqual(2);
  // /broken-link returns 404; the dead-link assertion should catch it.
  expect(() => chaos.expectNoDeadLinks(report)).toThrow(/broken-link/);
});

// ---------- pattern 2: withChaos extension ----------

const test = base.extend<ChaosFixtures>(withChaos({ maxPages: 5 }));

test("about page shows the heading", async ({ page, chaos }) => {
  await page.goto("/about");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("About");

  // Plain Playwright assertions still work — chaos.* is an *addition*,
  // not a replacement. A single test can mix both.
  const result = await chaos.testPage(page, `${BASE}/about`);
  chaos.expectNoErrors(result);
});
