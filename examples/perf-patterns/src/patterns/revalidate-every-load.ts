import { definePattern, handler, html, page, type Variant } from "../pattern.js";

const CHECK_DELAY_MS = 300;

// The site's stylesheet, in <head> on every page (so it blocks first paint).
// Its origin is far away: every request to it, a full download or a "has it
// changed?" check, takes a round trip of CHECK_DELAY_MS.
const stylesheet = Array.from(
  { length: 400 },
  (_, i) => `.c${i} { margin: ${i % 7}px; padding: ${i % 5}px; }`,
).join("\n");
const ETAG = `"site-css-3f9c1a"`;

const CACHE: Record<Variant, string> = {
  // Cacheable, but must be revalidated before every use: each page view sends
  // If-None-Match and waits for the 304 before it may paint.
  slow: "no-cache",
  // Fingerprinted file, cached for a year: later pages use it with no request.
  fixed: "public, max-age=31536000, immutable",
};

const DOCS = ["/docs/install", "/docs/config", "/docs/deploy"] as const;

const nav = `<nav>${["/", ...DOCS].map((p) => `<a href="${p}">${p === "/" ? "home" : p.slice(6)}</a>`).join(" · ")}</nav>`;

const doc = (title: string) =>
  html(
    page(
      title,
      `${nav}
<h1>${title}</h1>
<p>Every page of the site uses the same stylesheet.</p>`,
      `<link rel="stylesheet" href="/static/site.css">`,
    ),
  );

export default definePattern({
  id: "revalidate-every-load",
  title: "Static asset revalidated on every page view",
  category: "network",
  description: `The site's stylesheet is served with Cache-Control: no-cache and an ETag. The browser keeps a copy, but no-cache means "check with the server before every use", so each page view sends a conditional request and waits for the 304 before the render-blocking stylesheet may apply. Few bytes move, yet every page pays a round trip (${CHECK_DELAY_MS} ms here) before its first paint.`,
  fix: "Give fingerprinted static assets Cache-Control: public, max-age=31536000, immutable, so repeat views use the cached copy without asking; keep no-cache for the HTML.",
  routes: (variant) => ({
    "/": doc("Home"),
    "/docs/install": doc("Install"),
    "/docs/config": doc("Config"),
    "/docs/deploy": doc("Deploy"),
    "/static/site.css": handler(async (req, res) => {
      await new Promise((r) => setTimeout(r, CHECK_DELAY_MS));
      const headers = { "cache-control": CACHE[variant], etag: ETAG };
      if (req.headers["if-none-match"] === ETAG) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      res.writeHead(200, { ...headers, "content-type": "text/css; charset=utf-8", "content-length": Buffer.byteLength(stylesheet) });
      res.end(stylesheet);
    }),
  }),
  crawl: {
    // The home page first (it fills the cache), then the three doc pages it links to.
    maxPages: 4,
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    // Later page views only: the first one downloads the stylesheet on both variants.
    key: "/docs/* :: load",
    // Not bytes: a 304 is a few hundred bytes of headers, close to the fixed
    // variant's 0. The cost is the round trip in front of first paint.
    metric: "page.vitals.FCP.value",
    direction: "lower",
    // slow: each page waits ~300 ms for its 304; fixed: paints straight from cache (~30 ms).
    minImprovement: { ratio: 3, absolute: 150 },
  },
});
