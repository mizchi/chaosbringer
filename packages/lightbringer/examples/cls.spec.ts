import { test, expect } from "../src/index";

// Layout shift (CLS): a banner inserted ~400ms after load pushes content down.
// ?fixed reserves the space so nothing shifts. Gated via a web-vitals budget.
const url =
  process.env.BENCH_FIXED === "1" ? "/?scenario=cls&fixed" : "/?scenario=cls";

test.describe("bench: layout shift", () => {
  test("load", async ({ page, perf }) => {
    perf.setVitalsBudget({ CLS: 0.1 });
    await perf.measure("initial-load", async () => {
      await page.goto(url);
      await expect(page.locator("#content")).toBeVisible();
      await page.waitForTimeout(1200); // wait past the 400ms banner insertion
    });
  });
});
