import { test, expect } from "../src/index";

// Huge DOM: rendering 30k list items creates tens of thousands of nodes, making
// style/layout expensive. ?fixed windows it to 100. Lights up render.nodes.
const url =
  process.env.BENCH_FIXED === "1"
    ? "/?scenario=huge-dom&fixed"
    : "/?scenario=huge-dom";

test.describe("bench: huge DOM", () => {
  test("render big list", async ({ page, perf }) => {
    await perf.measure("initial-load", async () => {
      await page.goto(url);
      await expect(page.locator("#render")).toBeVisible();
    });

    await perf.measure(
      "render-list",
      async () => {
        await page.locator("#render").click();
        await expect(page.locator("#status")).toHaveText("done");
      },
      { budget: { nodes: 5000 } },
    );
  });
});
