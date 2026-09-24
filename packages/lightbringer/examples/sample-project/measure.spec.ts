// Fixture-based measurement of the sample app, with explicit named spans.
//
// In your own project this import is `from "lightbringer"`. Here it's a relative
// path because the sample lives inside the lightbringer repo.
import { test, expect } from "../../src/index";

test("sample store", async ({ page, perf }) => {
  // Put the waitFor inside the action so the span covers "until it's actually done".
  await perf.measure("initial-load", async () => {
    await page.goto("/");
    await expect(page.locator("li").first()).toBeVisible();
  });

  // A second fetch -> a new network wave; 300 more rows -> more DOM.
  await perf.measure("load-more", async () => {
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(page.locator("li").nth(300)).toBeVisible();
  });

  // No network — this is pure script/render cost (filter over the full list).
  await perf.measure("filter", async () => {
    await page.getByPlaceholder("Filter products").fill("Lamp");
  });

  // The leaky interaction repeated, so the memory trend shows up. Run with
  // PERF_MEM=1 for retained-only numbers:
  //   PERF_MEM=1 pnpm exec playwright test --config examples/sample-project/playwright.config.ts
  await perf.measureRepeat(
    "watch",
    async () => {
      await page.getByRole("button", { name: "Watch all" }).click();
    },
    { times: 4 },
  );
});
