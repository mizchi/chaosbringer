import { test, expect } from "../src/index";

// Dependent chain: each request needs the previous result (4 serial waves) and
// genuinely can't be parallelized. ?fixed collapses it into one combined endpoint.
// Lights up waves.
const url =
  process.env.BENCH_FIXED === "1" ? "/?scenario=chain&fixed" : "/?scenario=chain";

test.describe("bench: dependent chain", () => {
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
