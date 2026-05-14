/**
 * E2E for `loadPageScenarios` — real Chromium against the fixture
 * `/page-scenarios` route, which publishes two scenarios on
 * `window.__chaosbringer`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { loadPageScenarios } from "../../src/recipes/page-scenarios.js";
import { startFixtureServer } from "../site/server.js";

let server: Awaited<ReturnType<typeof startFixtureServer>>;
let browser: Browser;

beforeAll(async () => {
  server = await startFixtureServer(0);
  browser = await chromium.launch({ headless: true });
}, 30000);

afterAll(async () => {
  await browser?.close().catch(() => {});
  await server.close();
});

describe("loadPageScenarios against fixture", () => {
  it("harvests the scenarios the page declares on window.__chaosbringer", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${server.url}/page-scenarios`);
      const got = await loadPageScenarios(page);
      expect(got.map((r) => r.name).sort()).toEqual([
        "demo/visit-about",
        "demo/visit-form",
      ]);
      const visit = got.find((r) => r.name === "demo/visit-about")!;
      expect(visit.origin).toBe("page-declared");
      expect(visit.status).toBe("candidate");
      expect(visit.preconditions[0]?.urlPattern).toBe("/page-scenarios");
      expect(visit.postconditions[0]?.urlPattern).toBe("/about");
    } finally {
      await context.close();
    }
  }, 30000);

  it("returns an empty list on pages without the global", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${server.url}/about`);
      expect(await loadPageScenarios(page)).toEqual([]);
    } finally {
      await context.close();
    }
  }, 30000);

  it("trustPublisher=true promotes harvested scenarios to verified", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${server.url}/page-scenarios`);
      const got = await loadPageScenarios(page, { trustPublisher: true });
      expect(got.every((r) => r.status === "verified")).toBe(true);
    } finally {
      await context.close();
    }
  }, 30000);
});
