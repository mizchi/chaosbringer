import { test, expect } from "../src/index";

// Heavy-data stress: a large trace batch (150k user-timing marks) + many
// concurrent requests. This exercises lightbringer's own data handling, not the
// app — the collector must survive a Tracing.dataCollected batch larger than the
// spread-call argument limit and must not bloat the report with one entry per
// request. Run with PERF_TRACE=1 to stress the trace path.
const url =
  process.env.BENCH_FIXED === "1"
    ? "/?scenario=stress&fixed"
    : "/?scenario=stress";

test.describe("bench: stress", () => {
  test("heavy data", async ({ page, perf }) => {
    await perf.measure("initial-load", async () => {
      await page.goto(url);
      await expect(page.locator("#load")).toBeVisible();
    });

    await perf.measure("load-click", async () => {
      await page.locator("#load").click();
      await expect(page.locator("#status")).toHaveText("done");
    });
  });
});
