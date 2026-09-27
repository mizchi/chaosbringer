import { definePattern, handler, html, page, type Variant } from "../pattern.js";
import { noisePng } from "../png.js";

const IMG_PX = 480;
const IMG_DELAY_MS = 300;

const photo = noisePng(IMG_PX, 11);

// The same article on both variants, opening with a photo that a slow image
// server sends after IMG_DELAY_MS. The slow <img> has no width/height, so
// until the file arrives the browser gives it 0 × 0 and lays the article out
// at the top; when the image decodes it takes its full height and pushes the
// text down. The fixed <img> declares its size, so the box is reserved.
const dims: Record<Variant, string> = {
  slow: "",
  fixed: ` width="${IMG_PX}" height="${IMG_PX}"`,
};

export default definePattern({
  id: "cls-image-no-dimensions",
  title: "Image without width and height (CLS)",
  category: "render",
  description: `The article's lead photo has no width or height attributes. The page paints its text at once, with the image as a 0 × 0 box; ${IMG_DELAY_MS} ms later the photo arrives and grows to ${IMG_PX} px, and every line the reader was on jumps down: a large layout shift, counted in CLS.`,
  fix: "Give every <img> its width and height attributes (the browser derives the aspect ratio from them before the file arrives), or reserve the box with CSS aspect-ratio.",
  routes: (variant) => ({
    "/": html(
      page(
        "Article",
        `<header><strong>Daily News</strong></header>
<img class="lead" src="/img/lead.png" alt="Harbour at dawn"${dims[variant]}>
<article>
<h1>The harbour, rebuilt</h1>
${Array.from({ length: 12 }, (_, i) => `<p>Paragraph ${i + 1}. After two years of works the quay reopened this week, with new moorings for the fishing fleet and a wider promenade.</p>`).join("\n")}
</article>`,
        `<style>
  body { margin: 0; font: 18px/1.6 system-ui, sans-serif; }
  header, article { padding: 0 16px; }
  .lead { display: block; max-width: 100%; height: auto; }
</style>`,
      ),
    ),
    "/img/lead.png": handler(async (_req, res) => {
      await new Promise((r) => setTimeout(r, IMG_DELAY_MS));
      res.writeHead(200, { "content-type": "image/png", "content-length": photo.length, "cache-control": "no-store" });
      res.end(photo);
    }),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/ :: load",
    metric: "page.vitals.CLS.value",
    direction: "lower",
    // slow: the article (the whole viewport) moves down by the photo's 480 px, ~0.3; fixed: 0.
    minImprovement: { ratio: 5, absolute: 0.05 },
  },
});
