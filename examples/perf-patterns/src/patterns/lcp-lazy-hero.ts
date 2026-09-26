import { definePattern, handler, html, page, type Variant } from "../pattern.js";
import { noisePng } from "../png.js";

const HERO_PX = 600;
const THUMBS = 12;
const THUMB_PX = 200;
const THUMB_DELAY_MS = 400;

const hero = noisePng(HERO_PX, 7);
const thumbs = Array.from({ length: THUMBS }, (_, i) => noisePng(THUMB_PX, i + 1));

// The same page on both variants: a hero at the top, an article, and a
// gallery far below the fold. Only the loading attributes differ. The slow
// page has them the wrong way round: the hero, the one image in view, is
// lazy, and the gallery nobody has scrolled to is eager. The eager
// thumbnails take the browser's six connections to the host before layout
// even knows the hero is in view, so the hero waits for a round of them.
const heroImg: Record<Variant, string> = {
  slow: `<img class="hero" src="/img/hero.png" width="${HERO_PX}" height="${HERO_PX}" alt="Hero" loading="lazy">`,
  fixed: `<img class="hero" src="/img/hero.png" width="${HERO_PX}" height="${HERO_PX}" alt="Hero" fetchpriority="high">`,
};
const thumbLoading: Record<Variant, string> = { slow: "", fixed: ` loading="lazy"` };

export default definePattern({
  id: "lcp-lazy-hero",
  title: "Lazy-loaded hero image (LCP)",
  category: "network",
  description: `The hero image, the largest thing in the first viewport and so the LCP element, has loading="lazy", while the ${THUMBS}-image gallery far below the fold is eager. The browser only starts a lazy image after layout, by which time the gallery's thumbnails (${THUMB_DELAY_MS} ms each from a slow image server) hold every connection to the host, and the hero waits behind them.`,
  fix: 'Never lazy-load the LCP image: load it eagerly with fetchpriority="high" (or preload it), and put loading="lazy" on the below-the-fold images instead.',
  routes: (variant) => ({
    "/": html(
      page(
        "Travel",
        `${heroImg[variant]}
<h1>Ten days on the coast</h1>
<article>${Array.from({ length: 40 }, (_, i) => `<p>Day ${(i % 10) + 1}. We walked along the cliffs until the path ran out, then took the bus back to town for dinner by the harbour.</p>`).join("\n")}</article>
<div class="spacer"></div>
<h2>Gallery</h2>
<div class="gallery">${Array.from({ length: THUMBS }, (_, i) => `<img src="/img/thumb.png?n=${i}" width="${THUMB_PX}" height="${THUMB_PX}" alt="Photo ${i + 1}"${thumbLoading[variant]}>`).join("")}</div>`,
        `<style>
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; }
  .hero { display: block; }
  h1, h2, article { padding: 0 16px; }
  .spacer { height: 4000px; }
  .gallery { display: grid; grid-template-columns: repeat(4, ${THUMB_PX}px); gap: 8px; }
</style>`,
      ),
    ),
    "/img/hero.png": handler((_req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": hero.length, "cache-control": "no-store" });
      res.end(hero);
    }),
    "/img/thumb.png": handler(async (req, res) => {
      const n = Number(new URL(req.url ?? "/", "http://x").searchParams.get("n") ?? 0) % THUMBS;
      await new Promise((r) => setTimeout(r, THUMB_DELAY_MS));
      const png = thumbs[n]!;
      res.writeHead(200, { "content-type": "image/png", "content-length": png.length, "cache-control": "no-store" });
      res.end(png);
    }),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/ :: load",
    metric: "page.vitals.LCP.value",
    direction: "lower",
    // slow: the hero waits out both rounds of thumbnails (~2 × 400 ms); fixed: it loads first, ~50 ms.
    minImprovement: { ratio: 4, absolute: 300 },
  },
});
