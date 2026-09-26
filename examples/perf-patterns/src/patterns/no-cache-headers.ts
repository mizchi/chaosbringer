import { definePattern, handler, html, page, type Variant } from "../pattern.js";

// The site's shared assets: a ~200 KB script and a ~100 KB stylesheet that
// every page loads. Plain bytes (no compression), so the wire size is the
// file size and the metric reads the caching alone.
function filler(kb: number, line: (i: number) => string): string {
  const parts: string[] = [];
  let length = 0;
  for (let i = 0; length < kb * 1024; i++) {
    const l = line(i);
    parts.push(l);
    length += l.length + 1;
  }
  return parts.join("\n");
}

const script = filler(
  200,
  (i) => `window.__m${i} = function (x) { return (x || 0) + ${i} * 31 % 97; }; // module ${i} of the app bundle`,
);
const stylesheet = filler(100, (i) => `.c${i} { margin: ${i % 7}px; padding: ${i % 5}px; color: #${(i * 2654435761 % 0xffffff).toString(16).padStart(6, "0")}; }`);

const DOCS = ["/docs/install", "/docs/config", "/docs/deploy"] as const;

const nav = `<nav>${["/", ...DOCS].map((p) => `<a href="${p}">${p === "/" ? "home" : p.slice(6)}</a>`).join(" · ")}</nav>`;

const doc = (title: string) =>
  html(
    page(
      title,
      `${nav}
<h1>${title}</h1>
<p>Every page of the site loads the same script and stylesheet.</p>`,
      `<link rel="stylesheet" href="/static/site.css">
<script src="/static/app.js"></script>`,
    ),
  );

const CACHE: Record<Variant, string> = {
  // No caching allowed: every page view downloads both files again.
  slow: "no-store",
  // Fingerprinted file names make the content immutable: cache for a year.
  fixed: "public, max-age=31536000, immutable",
};

const asset = (variant: Variant, body: string, type: string) =>
  handler((_req, res) => {
    res.writeHead(200, {
      "content-type": `${type}; charset=utf-8`,
      "content-length": Buffer.byteLength(body),
      "cache-control": CACHE[variant],
    });
    res.end(body);
  });

export default definePattern({
  id: "no-cache-headers",
  title: "Static assets sent without caching headers",
  category: "network",
  description:
    "The site's ~300 KB of shared script and CSS is served with Cache-Control: no-store, so every page a visitor opens downloads it again, although it never changes between pages. The first page costs the same either way; every later page pays the whole download again.",
  fix: "Serve static assets under fingerprinted names (app.3f9c1a.js) with Cache-Control: public, max-age=31536000, immutable, and keep no-cache / short max-age for the HTML only.",
  routes: (variant) => ({
    "/": doc("Home"),
    "/docs/install": doc("Install"),
    "/docs/config": doc("Config"),
    "/docs/deploy": doc("Deploy"),
    "/static/app.js": asset(variant, script, "application/javascript"),
    "/static/site.css": asset(variant, stylesheet, "text/css"),
  }),
  crawl: {
    // The home page first (it warms the cache), then the three doc pages it links to.
    maxPages: 4,
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    // Later page views only: the first one downloads the assets on both variants.
    key: "/docs/* :: load",
    metric: "page.network.totalEncodedKB",
    direction: "lower",
    // slow: ~300 KB per page (both assets again); fixed: the HTML alone, ~1 KB.
    minImprovement: { ratio: 20, absolute: 150 },
  },
});
