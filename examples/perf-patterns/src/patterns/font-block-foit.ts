import { definePattern, handler, html, page, type Variant } from "../pattern.js";
import { boxFont } from "../font.js";

const FONT_DELAY_MS = 700;
const font = boxFont("Brand Sans");

// The same page and the same slow web font on both variants; only the
// @font-face's font-display differs. Without it (the default, `auto`, which
// Chrome treats as `block`), text set in the font is laid out but painted
// invisible until the font arrives (up to a 3 s block period): the flash of
// invisible text. `swap` paints the fallback at once and swaps the web font
// in when it lands.
const fontDisplay: Record<Variant, string> = {
  slow: "",
  fixed: "font-display: swap;",
};

export default definePattern({
  id: "font-block-foit",
  title: "Web font blocks text rendering (FOIT)",
  category: "network",
  description: `Every line of the page is set in a web font that takes ${FONT_DELAY_MS} ms to download, and its @font-face has no font-display. The browser then hides the text until the font arrives: the HTML is parsed and laid out at once, but the text stays invisible for ${FONT_DELAY_MS} ms, so LCP waits for the font.`,
  fix: "Add font-display: swap (or optional) to the @font-face so the fallback paints at once; preload the font (<link rel=preload as=font crossorigin>), subset it, and self-host it on the page's origin.",
  routes: (variant) => ({
    "/": html(
      page(
        "Article",
        `<h1>Notes from the field</h1>
${Array.from({ length: 8 }, (_, i) => `<p>Entry ${i + 1}. The survey team reached the ridge at noon and set up the station before the weather turned.</p>`).join("\n")}`,
        `<style>
  @font-face {
    font-family: "Brand Sans";
    src: url("/fonts/brand.ttf") format("truetype");
    ${fontDisplay[variant]}
  }
  body { margin: 0; padding: 0 16px; font: 18px/1.5 "Brand Sans", sans-serif; }
</style>`,
      ),
    ),
    "/fonts/brand.ttf": handler(async (_req, res) => {
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
    // Not FCP: Chrome fires first-contentful-paint for the invisible text as
    // soon as it is laid out (~40 ms on both variants). LCP only counts the
    // text once it is visible.
    metric: "page.vitals.LCP.value",
    direction: "lower",
    // slow: the text shows when the 700 ms font arrives; fixed: the fallback paints with the HTML (~50 ms).
    minImprovement: { ratio: 3, absolute: 350 },
  },
});
