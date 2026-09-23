import { test, expect } from "../src/index";

// Expensive synchronous work on every keystroke: typing filters + renders 4000
// expensive rows synchronously, blocking each key. ?fixed uses useDeferredValue so
// the input stays responsive. Lights up INP (compare report.vitals.INP).
const url =
  process.env.BENCH_FIXED === "1"
    ? "/?scenario=input&fixed"
    : "/?scenario=input";

test.describe("bench: keystroke INP", () => {
  test("type into filter", async ({ page, perf }) => {
    await perf.measure("initial-load", async () => {
      await page.goto(url);
      await expect(page.locator("#q")).toBeVisible();
    });

    await perf.measure("type", async () => {
      // real per-character key events -> each is an interaction for INP
      await page.locator("#q").pressSequentially("item 1", { delay: 80 });
      await expect(page.locator("#q")).toHaveValue("item 1");
    });
  });
});
