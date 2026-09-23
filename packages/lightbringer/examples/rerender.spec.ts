import { test, expect } from "../src/index";

// Measures one "+1" click. In the slow build the unrelated HeavyList re-renders
// (3000 expensive rows) on every click; ?fixed memoizes it so the click is cheap.
// Set BENCH_FIXED=1 to measure the fixed variant.
const url = process.env.BENCH_FIXED === "1" ? "/?fixed" : "/";

test.describe("bench: counter click re-render", () => {
  test("increment", async ({ page, perf }) => {
    await perf.measure("initial-load", async () => {
      await page.goto(url);
      await expect(page.locator("#inc")).toBeVisible();
    });

    await perf.measure(
      "increment-click",
      async () => {
        await page.locator("#inc").click();
        await expect(page.locator("#count")).toHaveText("1");
      },
      { budget: { scriptMs: 50 } },
    );
  });
});
