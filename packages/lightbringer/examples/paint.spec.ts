import { test, expect } from "../src/index";

// Paint-bound animation: slow animates box-shadow on a big element every frame
// (repaints a large area, no layout). ?fixed animates transform (compositor-only,
// no paint). Gate on paintCount (repaint frequency) — paintMs is tiny because the
// Paint event only records the display list; the real cost is GPU rasterization.
//   PERF_TRACE=1 pnpm exec playwright test paint.spec.ts
const url =
  process.env.BENCH_FIXED === "1" ? "/?scenario=paint&fixed" : "/?scenario=paint";

test.describe("bench: paint", () => {
  test("animate", async ({ page, perf }) => {
    await perf.measure("initial-load", async () => {
      await page.goto(url);
      await expect(page.locator("#run")).toBeVisible();
    });

    await perf.measure(
      "animate",
      async () => {
        await page.locator("#run").click();
        await expect(page.locator("#status")).toHaveText("done");
      },
      { budget: { paintCount: 50 } },
    );
  });
});
