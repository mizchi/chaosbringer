import { test, expect } from "../src/index";

// Initialization-time resource problem (init-reflow). The initial-load span captures
// the full init cost (waits for #ready, which appears only after init work).
const url =
  process.env.BENCH_FIXED === "1" ? "/?scenario=init-reflow&fixed" : "/?scenario=init-reflow";

test.describe("bench: init-reflow", () => {
  test("init", async ({ page, perf }) => {
    await perf.measure(
      "initial-load",
      async () => {
        await page.goto(url);
        await expect(page.locator("#ready")).toHaveText("ready", {
          timeout: 30_000,
        });
      },
      { budget: { layoutCount: 100 } },
    );
  });
});
