import { definePattern, handler, html, page, type Variant } from "../pattern.js";
import { boxFont } from "../font.js";

const CSS_DELAY_MS = 400;
const FONT_DELAY_MS = 400;
const font = boxFont("Brand Serif");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The site's stylesheet declares the brand font (@font-face) and sets the
// page's text in it; the @font-face keeps the default font-display, so text
// in that font stays hidden until the font has loaded (the brand look, no
// fallback flash). The browser does not fetch a font when it sees its
// @font-face, only once it has styled some text that uses it; neither the
// HTML parser nor the preload scanner looks inside a stylesheet. So the
// slow page's font request starts only after the stylesheet has arrived
// (400 ms) and the page has been styled, and the text shows a whole font
// download (400 ms) after that. The fixed page adds
// one line to <head>, <link rel=preload as=font crossorigin>, and the font
// downloads in parallel with the stylesheet.
//
// Unlike font-block-foit (whose fix is font-display, so the fallback paints
// while the font loads), both pages here keep the block behaviour; the fix
// is starting the download sooner.
const preload: Record<Variant, string> = {
  slow: "",
  // crossorigin is required: fonts are fetched in CORS mode, and a preload
  // without it does not match the font request, which then downloads again.
  fixed: `<link rel="preload" href="/fonts/brand-serif.ttf" as="font" type="font/ttf" crossorigin>`,
};

const APP_CSS = `@font-face {
  font-family: "Brand Serif";
  src: url("/fonts/brand-serif.ttf") format("truetype");
}
body { margin: 0; padding: 0 16px; font: 18px/1.5 "Brand Serif", serif; }
h1 { font-size: 32px; }`;

export default definePattern({
  id: "late-font-discovery",
  title: "Web font discovered late (only named in a stylesheet)",
  category: "network",
  description: `The page's font is declared in its stylesheet, and the browser only requests a font once it has styled text that uses it. So the font download cannot start until the stylesheet has arrived (${CSS_DELAY_MS} ms) and been applied, and the text, hidden until its font loads, shows ${FONT_DELAY_MS} ms after that: two downloads in a row where they could overlap.`,
  fix: "Preload the fonts the first view needs from the HTML's <head>: <link rel=preload href=… as=font type=font/woff2 crossorigin> (crossorigin even on the same origin, or the preload is not used); keep the preloads to the one or two faces above the fold.",
  routes: (variant) => ({
    "/": html(
      page(
        "Journal",
        `<h1>The ridge station journal</h1>
${Array.from({ length: 6 }, (_, i) => `<p>Day ${i + 1}. The survey team reached the ridge at noon and set up the station before the weather turned.</p>`).join("\n")}`,
        `${preload[variant]}
<link rel="stylesheet" href="/css/app.css">`,
      ),
    ),
    "/css/app.css": handler(async (_req, res) => {
      await sleep(CSS_DELAY_MS);
      res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
      res.end(APP_CSS);
    }),
    "/fonts/brand-serif.ttf": handler(async (_req, res) => {
      await sleep(FONT_DELAY_MS);
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
    // LCP, not FCP: text in a font's block period counts for FCP while it is
    // still invisible (see the pitfalls), but LCP waits until it shows.
    metric: "page.vitals.LCP.value",
    direction: "lower",
    // slow: stylesheet (400 ms), then font (400 ms), ~850 ms; fixed: both at
    // once, ~440 ms. The stylesheet still blocks both pages' first paint, so
    // the ratio cannot pass 2; the gain is one whole download.
    minImprovement: { ratio: 1.4, absolute: 200 },
    alsoExpect: [
      {
        // The same chain seen from the network: the last request (the font) ends
        // ~850 ms in against ~420 ms. The request count stays 3 on both pages, so
        // the crossorigin preload is used, not fetched a second time.
        metric: "network.settledMs",
        direction: "lower",
        minImprovement: { ratio: 1.4, absolute: 200 },
      },
    ],
  },
});
