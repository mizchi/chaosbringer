import { test, expect } from "../src/index";

// Forced synchronous layout: the click handler writes then reads each element's
// geometry in a loop, forcing a reflow every iteration. ?fixed batches all writes
// then all reads (one layout). Lights up render.layoutCount / layoutMs.
const url =
  process.env.BENCH_FIXED === "1"
    ? "/?scenario=reflow&fixed"
    : "/?scenario=reflow";

test.describe("bench: forced reflow", () => {
  test("reflow click", async ({ page, perf }) => {
    await perf.measure("initial-load", async () => {
      await page.goto(url);
      await expect(page.locator("#thrash")).toBeVisible();
    });

    await perf.measure(
      "reflow-click",
      async () => {
        await page.locator("#thrash").click();
        await expect(page.locator("#done")).toBeVisible();
      },
      { budget: { layoutCount: 100 } },
    );
  });
});
