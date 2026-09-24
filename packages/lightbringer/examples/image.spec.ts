import { test, expect } from "../src/index";

// Image over-fetch: slow renders a 1600×1600 image in an 80×80 box; ?fixed renders
// an 80×80 image. The cost surfaces in report.media.oversized (intrinsic px ≫
// rendered px) — shown in the summary as "oversized N×". No budget field (media is
// a page-level report, not a per-span metric); this is a demonstration / smoke.
const url =
  process.env.BENCH_FIXED === "1" ? "/?scenario=image&fixed" : "/?scenario=image";

test.describe("bench: image", () => {
  test("over-fetch", async ({ page, perf }) => {
    await perf.measure("initial-load", async () => {
      await page.goto(url);
      await expect(page.locator("#status")).toHaveText("done");
    });
  });
});
