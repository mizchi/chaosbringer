import { definePattern, handler, html, page, type Variant } from "../pattern.js";
import { boxFont } from "../font.js";

// The server sends fonts at ~2 MB/s (16 KB every 8 ms), a fast connection,
// so a download takes time in proportion to its size.
const CHUNK = 16 * 1024;
const CHUNK_INTERVAL_MS = 8;
const EXTRA_GLYPHS = 5000;

// The same page, the same family, the same @font-face (font-display: swap is
// already set on both variants); only the file differs. The slow site serves
// the family's full font: printable ASCII plus 5,000 CJK glyphs (~1.1 MB), as
// a font straight from the foundry or a "download all" webfont kit would be.
// The page's text is plain English, so it uses the 95 ASCII glyphs. The
// fixed site serves a subset with only those (~4 KB).
const fonts: Record<Variant, Buffer> = {
  slow: boxFont("Brand Sans", { extraGlyphs: EXTRA_GLYPHS }),
  fixed: boxFont("Brand Sans"),
};

const paced = (body: Buffer) =>
  handler(async (_req, res) => {
    res.writeHead(200, { "content-type": "font/ttf", "content-length": body.length, "cache-control": "no-store" });
    for (let o = 0; o < body.length; o += CHUNK) {
      if (o) await new Promise((r) => setTimeout(r, CHUNK_INTERVAL_MS));
      res.write(body.subarray(o, o + CHUNK));
    }
    res.end();
  });

export default definePattern({
  id: "font-no-subset",
  title: "Full web font served where a subset would do",
  category: "network",
  description: `The page's web font is ~${Math.round(fonts.slow.length / 1024)} KB: the family's complete file, with ${EXTRA_GLYPHS.toLocaleString("en-US")} CJK glyphs, although the page's text uses only the 95 printable ASCII characters. Every visitor downloads the whole file before the text can switch to the brand font, and on a slower connection it competes with the page's other critical requests.`,
  fix: "Subset fonts to the characters the site uses (pyftsubset / glyphhanger, or the font service's text= / subset options), split large scripts into unicode-range subsets the browser downloads only when a page needs them, and serve WOFF2.",
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
    font-display: swap;
  }
  body { margin: 0; padding: 0 16px; font: 18px/1.5 "Brand Sans", sans-serif; }
</style>`,
      ),
    ),
    "/fonts/brand.ttf": paced(fonts[variant]),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/ :: load",
    // The load's bytes: an exact size.
    metric: "network.encodedKB",
    direction: "lower",
    // slow: ~1.1 MB (the font) + the HTML; fixed: ~5 KB.
    minImprovement: { ratio: 20, absolute: 500 },
    alsoExpect: [
      {
        // When the load's requests are done: the font download, paced by the server.
        metric: "network.settledMs",
        direction: "lower",
        // slow: ~550 ms of font at ~2 MB/s; fixed: one chunk, a few ms after the HTML.
        minImprovement: { ratio: 2, absolute: 250 },
      },
    ],
  },
});
