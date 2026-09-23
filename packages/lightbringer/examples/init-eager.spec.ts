import { test, expect } from "../src/index";

// Initialization-time resource problem: expensive work done eagerly at boot that
// isn't needed for the initial view. ?fixed skips it at init (computes lazily on
// demand). Lights up initial-load scriptMs.
const url =
  process.env.BENCH_FIXED === "1"
    ? "/?scenario=init-eager&fixed"
    : "/?scenario=init-eager";

test.describe("bench: init-eager", () => {
  test("init", async ({ page, perf }) => {
    await perf.measure(
      "initial-load",
      async () => {
        await page.goto(url);
        await expect(page.locator("#ready")).toHaveText("ready", {
          timeout: 30_000,
        });
      },
      { budget: { scriptMs: 300 } },
    );
  });
});
