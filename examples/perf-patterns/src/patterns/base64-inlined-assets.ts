import { definePattern, handler, html, page, type Variant } from "../pattern.js";
import { noisePng } from "../png.js";

// The site's shared images: a logo, a header banner and a sidebar badge that
// every page shows (~195 KB of PNG). The slow site inlines them into each
// page's HTML as base64 data: URIs (a build setting like "inline every asset
// under N KB", set too high, or images pasted into a template). The HTML is
// per-page and not cacheable, so every page view downloads the images again,
// a third larger for the base64. The fixed site links them as files with a
// long immutable max-age, so later pages take them from the HTTP cache.
const IMAGES = [
  { name: "logo", size: 96, seed: 3 },
  { name: "banner", size: 200, seed: 5 },
  { name: "badge", size: 140, seed: 7 },
] as const;
const png = Object.fromEntries(IMAGES.map((img) => [img.name, noisePng(img.size, img.seed)]));

const DOCS = ["/docs/install", "/docs/config", "/docs/deploy"] as const;
const nav = `<nav>${["/", ...DOCS].map((p) => `<a href="${p}">${p === "/" ? "home" : p.slice(6)}</a>`).join(" · ")}</nav>`;

const src = (variant: Variant, name: string) =>
  variant === "slow" ? `data:image/png;base64,${png[name]!.toString("base64")}` : `/img/${name}.png`;

const doc = (variant: Variant, title: string) =>
  html(
    page(
      title,
      `${IMAGES.map((img) => `<img src="${src(variant, img.name)}" width="${img.size}" height="${img.size}" alt="${img.name}">`).join("\n")}
${nav}
<h1>${title}</h1>
<p>Every page of the site shows the same logo, banner and badge.</p>`,
    ),
  );

export default definePattern({
  id: "base64-inlined-assets",
  title: "Shared images inlined as base64 into every page",
  category: "network",
  description:
    "Every page's HTML is ~260 KB, although its text is a few hundred bytes. The site's logo, banner and badge are inlined as base64 data: URIs, so they travel inside each page's (uncacheable) HTML: every page view downloads them again, a third larger than the files, and the browser cannot cache, prioritise or lazy-load them separately.",
  fix: "Serve shared images as files with a long-lived Cache-Control (fingerprinted names, immutable); keep data: URIs for tiny, single-use assets (a few hundred bytes), and set bundlers' inline limits accordingly.",
  routes: (variant) => ({
    "/": doc(variant, "Home"),
    ...Object.fromEntries(DOCS.map((p) => [p, doc(variant, p.slice(6)[0]!.toUpperCase() + p.slice(7))])),
    // Both variants serve the files (same paths); only the fixed pages link them.
    ...Object.fromEntries(
      IMAGES.map((img) => [
        `/img/${img.name}.png`,
        handler((_req, res) => {
          const body = png[img.name]!;
          res.writeHead(200, {
            "content-type": "image/png",
            "content-length": body.length,
            "cache-control": "public, max-age=31536000, immutable",
          });
          res.end(body);
        }),
      ]),
    ),
  }),
  crawl: {
    // The home page first (the fixed site's cache warms there), then the doc pages.
    maxPages: 4,
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    // Later page views only: the first one downloads the images on both variants.
    key: "/docs/* :: load",
    metric: "page.network.totalEncodedKB",
    direction: "lower",
    // slow: ~260 KB of HTML per page; fixed: ~1 KB of HTML, images from cache.
    minImprovement: { ratio: 20, absolute: 150 },
  },
});
