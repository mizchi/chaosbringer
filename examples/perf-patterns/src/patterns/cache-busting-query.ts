import { definePattern, handler, page, type Variant } from "../pattern.js";

// The site's shared ~200 KB script and ~100 KB stylesheet, served with a
// year-long immutable Cache-Control on both variants: the headers are right.
// What differs is the URL the HTML asks for. The slow template appends the
// render time (`?v=<Date.now()>`) to "make sure users get the latest
// version", so every page view asks for a URL the cache has never seen and
// downloads both files again. The fixed template uses the file's content
// hash, which only changes when the file does.
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

const CONTENT_HASH = "3f9c1a";

const version: Record<Variant, () => string> = {
  // A new value on every render: never the same URL twice.
  slow: () => `${Date.now()}${Math.random().toString(36).slice(2, 8)}`,
  // Changes when the build changes the file, not per request.
  fixed: () => CONTENT_HASH,
};

const DOCS = ["/docs/install", "/docs/config", "/docs/deploy"] as const;

const nav = `<nav>${["/", ...DOCS].map((p) => `<a href="${p}">${p === "/" ? "home" : p.slice(6)}</a>`).join(" · ")}</nav>`;

// Server-rendered: the template runs per request, so the slow query differs per page view.
const doc = (variant: Variant, title: string) =>
  handler((_req, res) => {
    const v = version[variant]();
    const body = page(
      title,
      `${nav}
<h1>${title}</h1>
<p>Every page of the site loads the same script and stylesheet.</p>`,
      `<link rel="stylesheet" href="/static/site.css?v=${v}">
<script src="/static/app.js?v=${v}"></script>`,
    );
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  });

const asset = (body: string, type: string) =>
  handler((_req, res) => {
    res.writeHead(200, {
      "content-type": `${type}; charset=utf-8`,
      "content-length": Buffer.byteLength(body),
      "cache-control": "public, max-age=31536000, immutable",
    });
    res.end(body);
  });

export default definePattern({
  id: "cache-busting-query",
  title: "Cache-busting query string on every render",
  category: "network",
  description:
    "The shared ~300 KB of script and CSS has perfect caching headers (a year, immutable), yet every page view downloads it again: the HTML template appends the render time to the asset URLs (app.js?v=<Date.now()>) so that users \"always get the latest version\". Every URL is new, so the cache never hits.",
  fix: "Version assets by content (a content hash in the file name or query, set at build time), so the URL changes only when the file does; keep the long immutable max-age.",
  routes: (variant) => ({
    "/": doc(variant, "Home"),
    "/docs/install": doc(variant, "Install"),
    "/docs/config": doc(variant, "Config"),
    "/docs/deploy": doc(variant, "Deploy"),
    "/static/app.js": asset(script, "application/javascript"),
    "/static/site.css": asset(stylesheet, "text/css"),
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
    // slow: ~300 KB per page (new URLs); fixed: the HTML alone, ~1 KB.
    minImprovement: { ratio: 20, absolute: 150 },
  },
});
