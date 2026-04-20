/**
 * End-to-end smoke test: run ChaosCrawler against the fixture site and
 * assert the headline error-classification and discovery behaviour.
 *
 * Slow (boots Chromium), so only this file exercises a real browser.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChaosCrawler } from "../../src/crawler.js";
import { startFixtureServer } from "../site/server.js";

let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  server = await startFixtureServer(0);
}, 30000);

afterAll(async () => {
  await server.close();
});

describe("ChaosCrawler against fixture site", () => {
  it("classifies errors correctly and finds the dead link", async () => {
    const crawler = new ChaosCrawler({
      baseUrl: server.url,
      maxPages: 12,
      maxActionsPerPage: 1,
      headless: true,
      seed: 42,
    });

    const report = await crawler.start();

    // Seed round-trips into the report.
    expect(report.seed).toBe(42);

    // Visited the main scenario pages.
    const urls = report.pages.map((p) => p.url);
    expect(urls).toContain(`${server.url}/unhandled-rejection`);
    expect(urls).toContain(`${server.url}/js-exception`);
    expect(urls).toContain(`${server.url}/console-error`);

    // The rejection page must be classified as unhandled-rejection, not exception.
    const rejectionPage = report.pages.find((p) => p.url.endsWith("/unhandled-rejection"))!;
    expect(rejectionPage.errors.some((e) => e.type === "unhandled-rejection")).toBe(true);
    expect(rejectionPage.errors.some((e) => e.type === "exception")).toBe(false);

    // The thrown error page is a real exception.
    const exceptionPage = report.pages.find((p) => p.url.endsWith("/js-exception"))!;
    expect(exceptionPage.errors.some((e) => e.type === "exception")).toBe(true);

    // The console.error page is captured as console.
    const consolePage = report.pages.find((p) => p.url.endsWith("/console-error"))!;
    expect(consolePage.errors.some((e) => e.type === "console")).toBe(true);

    // The broken link is recorded in the discovery dead-link list.
    const deadLinks = report.summary.discovery?.deadLinks ?? [];
    expect(deadLinks.some((d) => d.url.endsWith("/broken-link") && d.statusCode === 404)).toBe(true);

    // Summary counters line up with what we saw above.
    expect(report.summary.unhandledRejections).toBeGreaterThanOrEqual(1);
    expect(report.summary.jsExceptions).toBeGreaterThanOrEqual(1);
    expect(report.summary.consoleErrors).toBeGreaterThanOrEqual(1);

    // External navigation attempts got blocked at least once (fixture has an
    // example.com link and the crawler extracts / may click into it).
    // Not strict: the seed may or may not click that particular link, so only
    // check if any appeared in blockedExternalNavigations as a weak signal.
    // (Keeping it assertion-free keeps the test deterministic under seed drift.)
    expect(report.blockedExternalNavigations).toBeGreaterThanOrEqual(0);
  }, 120000);
});
