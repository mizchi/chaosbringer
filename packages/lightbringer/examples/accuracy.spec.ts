import { test, expect } from "../src/index";

// Measurement-accuracy probe. A page-owned click handler busies the main thread
// for a known number of ms; we compare the reported numbers to ground truth.
//
// IMPORTANT: work injected via page.evaluate is invisible to the Long Tasks API
// and to CDP ScriptDuration, so the busy work must run from the page's own script
// (here, a real click handler) to be measured at all.
//
//   pnpm exec playwright test accuracy.spec.ts              # baseline
//   PERF_TRACE=1 pnpm exec playwright test accuracy.spec.ts # tracing observer effect

const PAGE = `<!doctype html><meta charset=utf8>
<script>
  window.burn = (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) {} };
</script>
<button id=b onclick="window.burn(Number(b.dataset.ms||0))">go</button>`;

async function clickBurn(page: import("@playwright/test").Page, ms: number) {
  await page.evaluate((m) => {
    document.getElementById("b")!.dataset.ms = String(m);
  }, ms);
  await page.locator("#b").click();
}

test.describe("accuracy", () => {
  test("known busy handlers vs reported numbers", async ({ page, perf }) => {
    // goto (not setContent) so addInitScript / the browser collector run.
    await page.goto(
      "data:text/html;charset=utf-8," + encodeURIComponent(PAGE),
    );

    await perf.measure("idle-floor", async () => {
      // no work: whatever shows up is pure harness floor
    });

    // budgets are upper bounds on the (very stable) scriptMs. Lower one below the
    // measured value to see the gate fire (inline with PERF_ASSERT=1, or in the
    // median script which exits non-zero).
    await perf.measure(
      "busy-100",
      async () => {
        await clickBurn(page, 100);
      },
      { budget: { scriptMs: 200 } },
    );

    await perf.measure(
      "busy-200",
      async () => {
        await clickBurn(page, 200);
      },
      { budget: { scriptMs: 300 } },
    );

    await perf.measure("busy-200-with-expect", async () => {
      await clickBurn(page, 200);
      await expect(page.locator("#b")).toBeVisible();
    });
  });
});
