import { test, expect } from "../src/index";

// Cross-step memory growth: repeat the same "alloc" click N times with
// measureRepeat. A single step's delta is GC-noisy, but a value that climbs every
// repeat is the real leak signal. Slow retains on every click (listeners /
// ArrayBuffers / heap climb monotonically); ?fixed releases (the trend is flat).
// Run with PERF_MEM=1 so each repeat's memory is measured after a forced GC:
//   PERF_MEM=1 pnpm exec playwright test examples/leak-trend.spec.ts
const url =
  process.env.BENCH_FIXED === "1" ? "/?scenario=leak&fixed" : "/?scenario=leak";

test.describe("bench: leak-trend", () => {
  test("repeated alloc", async ({ page, perf }) => {
    await perf.measure("initial-load", async () => {
      await page.goto(url);
      await expect(page.locator("#alloc")).toBeVisible();
    });

    // Six repeats; buildReport reports monotonic growth (report.trends) and the
    // summary flags "⚠ likely leak" on the slow path. The fixed path stays flat.
    await perf.measureRepeat(
      "alloc",
      async () => {
        await page.locator("#alloc").click();
      },
      { times: 6 },
    );
  });
});
