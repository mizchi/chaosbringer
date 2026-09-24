import { test, expect, type Page } from "@playwright/test";
import { startSession } from "../src/core";

// A navigation whose document request is never answered leaves Playwright
// waiting for the new document's execution context before it runs any
// page.evaluate — and that context never appears until Chromium gives up on the
// request (about two minutes). Every in-page read lightbringer makes at a span
// boundary or in finish() is bounded by `evaluateTimeoutMs`, so a hung page
// costs a few bounded waits instead of stalling the caller (a crawler
// measured one such page at 126 s before this bound existed).

const ORIGIN = "http://lb-hang.test";
const EVALUATE_TIMEOUT_MS = 1_000;

async function servePages(page: Page) {
  await page.route(`${ORIGIN}/**`, (route) => {
    // /hang: accept the request and never answer it.
    if (new URL(route.request().url()).pathname === "/hang") return;
    return route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><meta charset=utf8><title>a</title><h1>a</h1>",
    });
  });
}

test.describe("evaluate timeout", () => {
  test("span boundaries and finish() return within the bound on a hung document", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await servePages(page);
    const client = await page.context().newCDPSession(page);
    const session = await startSession(page, client, {
      evaluateTimeoutMs: EVALUATE_TIMEOUT_MS,
    });
    const perf = session.controller;

    await page.goto(`${ORIGIN}/a`);
    const handle = await perf.begin("goto-hang");
    await page.goto(`${ORIGIN}/hang`, { timeout: 500 }).catch(() => {});

    // From here on the navigation is still pending: an unbounded evaluate
    // would not return for minutes.
    const t0 = Date.now();
    await perf.end(handle, { settle: false });
    const endMs = Date.now() - t0;

    const t1 = Date.now();
    const { report } = await session.finish("hang");
    const finishMs = Date.now() - t1;

    // One bounded wait each at most: after the first read times out, the rest
    // short-circuit while it is still pending (they would queue behind it).
    expect(endMs).toBeLessThan(EVALUATE_TIMEOUT_MS * 3);
    expect(finishMs).toBeLessThan(EVALUATE_TIMEOUT_MS * 3);
    // The span is still recorded, with the fallbacks.
    expect(report.spans.map((s) => s.name)).toEqual(["goto-hang"]);
  });
});
