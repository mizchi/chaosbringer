/**
 * The `__name` helper a run from `src/` through tsx needs in the page (see
 * `installKeepNamesHelper`) stays out of the pages of a build without
 * esbuild's keepNames. The test runner's transform is one, as tsc's dist/ is;
 * a run that needs the helper is covered by cli.e2e.test.ts.
 */
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMPILED_WITH_KEEP_NAMES, newIsolatedPage } from "./browser-session.js";

describe("installKeepNamesHelper", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it("adds no global to the page of a build without keepNames", async () => {
    expect(COMPILED_WITH_KEEP_NAMES).toBe(false);
    const { page, close } = await newIsolatedPage(browser);
    try {
      await page.goto("data:text/html,<title>t</title>");
      expect(await page.evaluate(() => "__name" in globalThis)).toBe(false);
    } finally {
      await close();
    }
  }, 30_000);
});
