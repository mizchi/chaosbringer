import { test, expect } from "../src/index";

// CSS selector match cost: clicking "restyle" toggles a class on a container, so
// the whole subtree is recalculated — re-running every selector against every
// element. Slow has a big DOM × many complex, mostly-non-matching selectors
// (O(elements × selectors)); ?fixed has a small DOM and a couple of flat class
// selectors. The cost surfaces as render.recalcStyleMs (gated below). Add
// PERF_CSS=1 then `node scripts/drilldown.mjs <slug> restyle` to see which
// selectors cost the recalc (and which are wasteful: many attempts, never match).
const url =
  process.env.BENCH_FIXED === "1"
    ? "/?scenario=selector-cost&fixed"
    : "/?scenario=selector-cost";

test.describe("bench: selector-cost", () => {
  test("restyle", async ({ page, perf }) => {
    await perf.measure("initial-load", async () => {
      await page.goto(url);
      await expect(page.locator("#restyle")).toBeVisible();
    });

    await perf.measure(
      "restyle",
      async () => {
        await page.locator("#restyle").click();
        await expect(page.locator("#status")).toHaveText("on");
      },
      // measure recalcStyleMs WITHOUT PERF_CSS (instrumentation inflates the time);
      // slow is ~22ms here, fixed ~0.5ms.
      { budget: { recalcStyleMs: 10 } },
    );
  });
});
