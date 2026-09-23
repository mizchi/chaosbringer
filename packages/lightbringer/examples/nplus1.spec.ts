import { test, expect } from "../src/index";

// N+1: a list request then one request per item (1 + 5 = 6 serial). ?fixed uses a
// batch endpoint (2 requests). Lights up requestCount and waves.
const url =
  process.env.BENCH_FIXED === "1"
    ? "/?scenario=nplus1&fixed"
    : "/?scenario=nplus1";

test.describe("bench: N+1 requests", () => {
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
      { budget: { requestCount: 2 } },
    );
  });
});
