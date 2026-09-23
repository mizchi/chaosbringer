import { test, expect } from "../src/index";

// Serial request waterfall: four 200ms requests are awaited one-by-one (4 waves,
// ~800ms busy). ?fixed runs them with Promise.all (1 wave, ~200ms). Lights up
// network.waves / busyMs with no CPU cost.
const url =
  process.env.BENCH_FIXED === "1"
    ? "/?scenario=network&fixed"
    : "/?scenario=network";

test.describe("bench: request waterfall", () => {
  test("load", async ({ page, perf }) => {
    await perf.measure("initial-load", async () => {
      await page.goto(url);
      await expect(page.locator("#load")).toBeVisible();
    });

    await perf.measure(
      "load-click",
      async () => {
        await page.locator("#load").click();
        await expect(page.locator("#status")).toHaveText("done");
      },
      { budget: { waves: 1 } },
    );
  });
});
