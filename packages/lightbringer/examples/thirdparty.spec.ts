import { test, expect } from "../src/index";

// Third-party weight: clicking "load" pulls analytics / ad / tag-manager scripts
// from a different origin (127.0.0.1 vs the page's localhost) — ~270KB and CPU
// the app never shipped. ?fixed loads none. The cost surfaces under
// network.thirdParty (gated below); add PERF_TRACE=1 then
//   node scripts/drilldown.mjs <slug> load-click
// to see the third-party CPU self time per domain.
const url =
  process.env.BENCH_FIXED === "1"
    ? "/?scenario=thirdparty&fixed"
    : "/?scenario=thirdparty";

test.describe("bench: third-party", () => {
  test("load", async ({ page, perf }) => {
    await perf.measure("initial-load", async () => {
      await page.goto(url);
      await expect(page.locator("#load")).toBeVisible();
    });

    await perf.measure(
      "load-click",
      async () => {
        await page.locator("#load").click();
        await expect(page.locator("#status")).toHaveText("done");
      },
      // the app's own assets are first-party; the budget caps what non-app
      // origins are allowed to add.
      { budget: { thirdPartyKB: 50, thirdPartyRequestCount: 1 } },
    );
  });
});
