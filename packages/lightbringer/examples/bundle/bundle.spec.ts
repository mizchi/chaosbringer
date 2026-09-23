import { test, expect } from "../../src/index";

// Production-build fixture: the metrics that a dev server can't show.
// Run with coverage on:  PERF_COV=1 pnpm exec playwright test -c playwright.bundle.config.ts
// Then for suite-wide dead code:  node scripts/coverage.mjs
//
// Expect in the summary / report:
//   - coverage: the "features" chunk mostly unused (shipped, never executed) and
//     vendor-react partially used — real chunk-split signal.
//   - render-blocking: 1 css (the extracted stylesheet <link>).
//   - media: /photo.png oversized (1600×1200 shown 128×96) with REAL KB.
test.describe("bundle: build-dependent metrics", () => {
  test("load", async ({ page, perf }) => {
    await perf.measure("initial-load", async () => {
      await page.goto("/");
      await expect(page.locator("#out")).toBeVisible();
    });
  });
});
