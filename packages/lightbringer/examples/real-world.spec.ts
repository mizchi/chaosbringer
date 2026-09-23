import { test } from "../src/index";

// Observation-only specs against noisy, ad-heavy production sites. Unlike the
// synthetic fixtures these have huge request counts, third-party scripts, and
// run-to-run variance — a stress test for the harness (use --repeat-each + median).
// Diverse "slow site" patterns: ad/tracker-heavy news, JP widget portals, media
// SPAs with heavy hydration. Each stresses a different cause of slowness.
const sites = [
  { name: "nicovideo", url: "https://www.nicovideo.jp/" }, // video portal, ad + thumbnail heavy
  { name: "goal", url: "https://www.goal.com/en" }, // sports news, ad/tracker heavy
  { name: "yahoo-jp", url: "https://www.yahoo.co.jp/" }, // JP portal, many widgets + ads
  { name: "cnn", url: "https://edition.cnn.com/" }, // US news, ad + video heavy
  { name: "youtube", url: "https://www.youtube.com/" }, // media SPA, heavy hydration
  { name: "weather", url: "https://weather.com/" }, // very JS / ad heavy
  // SSR/SSG + hydration: fast paint (server HTML, good LCP) but a hidden hydration
  // cost a paint-only view misses — a CPU long task, a burst of style/layout
  // recalcs, or layout shift (CLS) as the client bundle attaches.
  { name: "nextjs", url: "https://nextjs.org/" }, // Next.js (React) hydration
  { name: "vercel-store", url: "https://demo.vercel.store/" }, // Next.js Commerce demo
  { name: "nuxt", url: "https://nuxt.com/" }, // Nuxt (Vue) hydration
  // e-commerce: product grids + personalization + heavy tracking, often a large DOM.
  { name: "rakuten", url: "https://www.rakuten.co.jp/" }, // JP EC portal, very heavy
  { name: "allbirds", url: "https://www.allbirds.com/" }, // Shopify store
  { name: "uniqlo", url: "https://www.uniqlo.com/us/en/" }, // EC, heavy JS
];

for (const site of sites) {
  test.describe(`real: ${site.name}`, () => {
    test.setTimeout(120_000);

    test("load and scroll", async ({ page, perf }) => {
      await perf.measure("initial-load", async () => {
        await page.goto(site.url, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        // let post-DCL work (hydration, ads, lazy content) run
        await page.waitForTimeout(3000);
      });

      await perf.measure("scroll", async () => {
        await page.mouse.wheel(0, 5000);
        await page.waitForTimeout(2000);
      });
    });
  });
}
