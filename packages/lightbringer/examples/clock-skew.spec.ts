import { test, expect, type Page } from "@playwright/test";
import { collectorInitScript, startSession } from "../src/core";
// The real chaosbringer runtime-fault script, not a hand-copied subset, so the
// spec follows the fault if it starts patching more of the clock. (A
// devDependency only: lightbringer itself does not depend on playwright-faults.)
import { buildRuntimeFaultsScript } from "@mizchi/playwright-faults";

// Clock-skew immunity. chaosbringer's `clock-skew` runtime fault shifts
// performance.now / Date.now (and `new Date()`) forward in page JS. The collector
// captures the native clock when it is installed, so it must run BEFORE the
// fault's init script: install collectorInitScript() at context level first and
// tell startSession not to add it again (installCollector: false).

const SKEW_MS = 60 * 60 * 1000;
const SKEW_SCRIPT = buildRuntimeFaultsScript(
  [{ action: { kind: "clock-skew", skewMs: SKEW_MS } }],
  1,
);

const ORIGIN = "http://lb-skew.test";
const PAGE = `<!doctype html><meta charset=utf8>
<script>
  // performance.now is skewed by a constant, so this still burns ~ms.
  window.burn = (ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) {} };
</script>
<button id=b onclick="window.burn(120)">burn</button>`;

async function serve(page: Page) {
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: PAGE }),
  );
}

test.describe("clock-skew", () => {
  test("span timing ignores a +1h performance.now / Date.now skew", async ({ context, page }) => {
    await context.addInitScript({ content: collectorInitScript() });
    await context.addInitScript({ content: SKEW_SCRIPT });
    await serve(page);
    const client = await context.newCDPSession(page);
    const session = await startSession(page, client, { installCollector: false });
    const perf = session.controller;

    await page.goto(`${ORIGIN}/`);
    // the skew is really active in page JS
    const skewed = await page.evaluate(() => Date.now());
    expect(skewed - Date.now()).toBeGreaterThan(SKEW_MS - 60_000);

    await perf.measure("burn", async () => {
      await page.locator("#b").click();
    });
    const { report } = await session.finish("clock-skew");
    const s = report.spans[0];
    expect(s.durationMs).toBeGreaterThanOrEqual(0);
    expect(s.durationMs).toBeLessThan(10_000);
    // span epochs are on the real clock, so native long-task entries line up
    const raw = perf.spans[0];
    expect(Math.abs(raw.startEpochMs - Date.now())).toBeLessThan(60_000);
    expect(s.cpu.longTaskCount).toBeGreaterThanOrEqual(1);
    expect(s.cpu.maxLongTaskMs).toBeGreaterThanOrEqual(100);
    expect(report.clockPatched).toBeUndefined();
  });

  test("the collector is idempotent when injected twice", async ({ context, page }) => {
    await context.addInitScript({ content: collectorInitScript() });
    await serve(page);
    const client = await context.newCDPSession(page);
    // installCollector defaults to true: a second copy lands at page level.
    const session = await startSession(page, client);
    await page.goto(`${ORIGIN}/a`);
    // Navigate inside the span: a second, orphaned copy would re-send the burn
    // through its own pagehide emit, double-counting it.
    await session.controller.measure("burn-then-leave", async () => {
      await page.locator("#b").click();
      await page.goto(`${ORIGIN}/b`);
    });
    const { report } = await session.finish("idempotent");
    expect(report.spans[0].cpu.longTaskCount).toBe(1);
    expect(report.clockPatched).toBeUndefined();
  });

  test("the default install order (fault first) is flagged as clockPatched", async ({
    context,
    page,
  }) => {
    await context.addInitScript({ content: SKEW_SCRIPT });
    await serve(page);
    const client = await context.newCDPSession(page);
    // page-level collector: runs after the context-level fault
    const session = await startSession(page, client);
    await page.goto(`${ORIGIN}/`);
    await session.controller.measure("burn", async () => {
      await page.locator("#b").click();
    });
    const { report } = await session.finish("clock-patched");
    expect(report.clockPatched).toBe(true);
  });
});
