import { test, expect } from "../src/index";

// Minimal example measuring a public page.
//   pnpm exec playwright test                          # numbers only
//   PERF_TRACE=1 pnpm exec playwright test             # also save a Chrome trace
//   pnpm exec playwright test --repeat-each=5 && pnpm median
//
// Reports land in perf-results/<title>.run<idx>.json and a summary is logged.

test.describe("perf: example.com", () => {
  test("measure initial load and a follow-up navigation", async ({
    page,
    perf,
  }) => {
    await perf.measure("initial-load", async () => {
      await page.goto("https://example.com");
      await expect(page.getByRole("heading")).toBeVisible();
    });

    // App spans: a region your app code wraps with withSpan() shows up nested
    // inside the operation span. Here we emit one manually to demonstrate.
    await perf.measure("app-work", async () => {
      await page.evaluate(() => {
        performance.mark("demo:start");
        const t0 = performance.now();
        while (performance.now() - t0 < 20) {
          /* busy */
        }
        performance.measure("demo-work", {
          start: "demo:start",
          detail: { __lbSpan: true, attributes: { kind: "cpu" } },
        });
      });
    });
  });
});
