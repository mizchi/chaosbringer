import { test, expect } from "../src/index";

// Validation against a real, non-canvas OSS React app (react.dev). Proves the
// harness is not map/canvas-specific and exercises the CPU-profiler self time on
// real React work (hydration + client-side route transitions).
//
//   PERF_CPU=4 PERF_TRACE=1 pnpm exec playwright test react-dev.spec.ts
//   node scripts/drilldown.mjs <slug> navigate-docs

test.describe("perf: react.dev", () => {
  test.setTimeout(120_000);

  test("measure load and a client-side docs navigation", async ({
    page,
    perf,
  }) => {
    await perf.measure("initial-load", async () => {
      await page.goto("https://react.dev/learn");
      await expect(
        page.getByRole("heading", { name: "Quick Start", level: 1 }),
      ).toBeVisible({ timeout: 30_000 });
    });

    // client-side navigation = React render of a new page (no full reload)
    await perf.measure("navigate-docs", async () => {
      await page
        .getByRole("link", { name: "Thinking in React", exact: true })
        .first()
        .click();
      await expect(
        page.getByRole("heading", { name: "Thinking in React", level: 1 }),
      ).toBeVisible({ timeout: 30_000 });
    });
  });
});
