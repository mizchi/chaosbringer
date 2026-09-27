import { definePattern, handler, html, page, type Variant } from "../pattern.js";
import { boxFont } from "../font.js";
import { noisePng } from "../png.js";

const HERO_PX = 320;
const SLIDE_PX = 480;

const hero = noisePng(HERO_PX, 3);
const slides = [noisePng(SLIDE_PX, 21), noisePng(SLIDE_PX, 22), noisePng(SLIDE_PX, 23)];
const font = boxFont("Brand Display");
// The rich-text editor bundle of another page: ~200 KB of script.
const editorJs = Buffer.from(`/* editor v5 */window.__editor = ${JSON.stringify("x".repeat(200 * 1024))}.length;`);

// Both pages show the same hero image and the same text. Their <head>s
// differ in the preload hints. The slow page's head still preloads what an
// older design used: three carousel slides (the carousel is gone), the
// display font of a heading that now uses the system font, and the editor
// bundle of the compose page. The browser fetches every preload at high
// priority whether or not the page uses it. The fixed page preloads only
// its LCP image.
const preloads: Record<Variant, string> = {
  slow: `<link rel="preload" as="image" href="/img/hero.png" fetchpriority="high">
<link rel="preload" as="image" href="/img/slide-1.png">
<link rel="preload" as="image" href="/img/slide-2.png">
<link rel="preload" as="image" href="/img/slide-3.png">
<link rel="preload" as="font" type="font/ttf" href="/fonts/display.ttf" crossorigin>
<link rel="preload" as="script" href="/js/editor.js">`,
  fixed: `<link rel="preload" as="image" href="/img/hero.png" fetchpriority="high">`,
};

const asset = (type: string, body: Buffer) =>
  handler((_req, res) => {
    res.writeHead(200, { "content-type": type, "content-length": body.length, "cache-control": "no-store" });
    res.end(body);
  });

export default definePattern({
  id: "unused-preload",
  title: "Preloads for resources the page never uses",
  category: "network",
  description:
    "The page's <head> preloads three carousel slides, a display font and another page's editor bundle, none of which the page uses any more (the preload hints outlived a redesign). The browser downloads every preload at high priority as soon as it sees the hint, so each visit pays ~2 MB for nothing, competing with the resources the page does need.",
  fix: "Preload only what the current page needs early and cannot discover sooner (typically the LCP image or a critical font); audit hints when the page changes (Chrome warns about a preload unused a few seconds after load).",
  routes: (variant) => ({
    "/": html(
      page(
        "Home",
        `<h1>Field notes</h1>
<img src="/img/hero.png" width="${HERO_PX}" height="${HERO_PX}" alt="Ridge at dawn">
<p>Stories from the survey season.</p>`,
        preloads[variant],
      ),
    ),
    "/img/hero.png": asset("image/png", hero),
    "/img/slide-1.png": asset("image/png", slides[0]!),
    "/img/slide-2.png": asset("image/png", slides[1]!),
    "/img/slide-3.png": asset("image/png", slides[2]!),
    "/fonts/display.ttf": asset("font/ttf", font),
    "/js/editor.js": asset("text/javascript; charset=utf-8", editorJs),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/ :: load",
    metric: "page.network.totalEncodedKB",
    direction: "lower",
    // slow: ~2,400 KB (hero + 3 slides + font + editor bundle); fixed: ~290 KB (the hero).
    minImprovement: { ratio: 3, absolute: 800 },
    alsoExpect: [
      {
        metric: "network.requestCount",
        direction: "lower",
        // slow: 7 requests on load; fixed: 2 (the document and the hero).
        minImprovement: { absolute: 4 },
      },
    ],
  },
});
