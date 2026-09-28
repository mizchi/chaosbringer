import { definePattern, handler, html, page, type Variant } from "../pattern.js";
import { boxFont } from "../font.js";

const FONT_DELAY_MS = 300;
// The web font's vertical metrics: 1.6 em above the baseline, 0.6 em below,
// so `line-height: normal` is 2.2 em in it, against ~1.15 em in the usual
// fallback sans (Liberation Sans, Arial, DejaVu Sans).
const ASCENT = 1600;
const DESCENT = 600;
const font = boxFont("Brand Display", { ascent: ASCENT, descent: DESCENT });

// Both variants use font-display: swap, so the text paints at once in the
// fallback and the web font replaces it when it lands. The page uses the
// font's own line height (`line-height: normal`, as headings, buttons and
// most components do), so on the slow page every line grows by ~1 em when the
// font swaps in and everything below moves down: a layout shift the size of
// the page. The fixed page declares its fallback as an @font-face of its own
// over a local font, with ascent-override / descent-override / line-gap-override
// set to the web font's metrics, so the fallback lines are already as tall.
// The lines are short and never wrap, so the font's widths move nothing.
const fallbackFace: Record<Variant, string> = {
  slow: "",
  fixed: `@font-face {
    font-family: "Brand Display Fallback";
    src: local("Liberation Sans"), local("Arial"), local("Helvetica"), local("DejaVu Sans"), local("FreeSans"), local("Noto Sans");
    ascent-override: ${ASCENT / 10}%;
    descent-override: ${DESCENT / 10}%;
    line-gap-override: 0%;
  }`,
};
const family: Record<Variant, string> = {
  slow: `"Brand Display", sans-serif`,
  fixed: `"Brand Display", "Brand Display Fallback", sans-serif`,
};

export default definePattern({
  id: "font-swap-cls",
  title: "Web font swap shifts the layout (fallback metrics differ)",
  category: "render",
  description: `The page's text is set in a web font with font-display: swap: it paints at once in the fallback, and the web font replaces it when it arrives ${FONT_DELAY_MS} ms later. The two fonts' vertical metrics differ a lot (the web font's natural line height is 2.2 em, the fallback's ~1.15 em), so at the swap every line grows and the whole page below the first line jumps down: a large layout shift, counted in CLS, on every visit with a cold cache.`,
  fix: "Match the fallback to the web font: declare the fallback as an @font-face over a local() font with size-adjust, ascent-override, descent-override and line-gap-override set to the web font's metrics (next/font and Fontaine generate these), or use font-display: optional so a late font is not swapped in.",
  routes: (variant) => ({
    "/": html(
      page(
        "Release notes",
        `<h1>Release notes</h1>
${Array.from({ length: 16 }, (_, i) => `<p>Version 4.${16 - i}: faster sync, fewer retries.</p>`).join("\n")}`,
        `<style>
  @font-face {
    font-family: "Brand Display";
    src: url("/fonts/display.ttf") format("truetype");
    font-display: swap;
  }
  ${fallbackFace[variant]}
  body { margin: 0; padding: 0 16px; font: 18px/normal ${family[variant]}; }
  h1 { font-size: 28px; line-height: normal; }
  p { margin: 0; }
</style>`,
      ),
    ),
    "/fonts/display.ttf": handler(async (_req, res) => {
      await new Promise((r) => setTimeout(r, FONT_DELAY_MS));
      res.writeHead(200, { "content-type": "font/ttf", "content-length": font.length, "cache-control": "no-store" });
      res.end(font);
    }),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/ :: load",
    // The font lands during the load span (the settle waits for its request),
    // so the swap's shift is inside the visit.
    metric: "page.vitals.CLS.value",
    direction: "lower",
    // slow: 17 lines each ~1 em taller at the swap, ~0.2; fixed: the fallback's
    // lines already have the web font's height, 0.
    minImprovement: { ratio: 5, absolute: 0.05 },
  },
});
