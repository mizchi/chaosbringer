import { test, expect } from "../src/index";

// Memory load: each "alloc" click retains ~200k on-heap objects, 30 ArrayBuffers,
// and 20 listener-bearing detached DOM nodes in a cache that never evicts, so the
// JS heap / ArrayBuffer count / listener count climb. ?fixed does the same work
// but keeps nothing. Run with PERF_MEM=1 so the deltas are measured AFTER a forced
// GC — otherwise they include the step's own not-yet-collected garbage and the
// slow / fixed paths look identical. The reliable per-run leak signals are the
// counts (listeners / ArrayBuffers / documents); jsHeapDeltaMB is directional but
// noisy because a single step's allocation may not be collected in time. This is
// per-step memory *load*, not a heap-snapshot retained-graph analysis.
const url =
  process.env.BENCH_FIXED === "1" ? "/?scenario=leak&fixed" : "/?scenario=leak";

test.describe("bench: leak", () => {
  test("alloc", async ({ page, perf }) => {
    await perf.measure("initial-load", async () => {
      await page.goto(url);
      await expect(page.locator("#alloc")).toBeVisible();
    });

    // Slow retains 20 listeners per click; fixed unbinds them (net ~0). The
    // listener count is GC-stable, so it's the gate. Trust it under PERF_MEM=1.
    await perf.measure(
      "alloc-click",
      async () => {
        await page.locator("#alloc").click();
        await expect(page.locator("#count")).toHaveText("1");
      },
      { budget: { listenersDelta: 5 } },
    );
  });
});
