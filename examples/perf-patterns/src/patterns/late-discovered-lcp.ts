import { definePattern, handler, html, page, type Variant } from "../pattern.js";
import { noisePng } from "../png.js";

const HERO_PX = 600;
const SCRIPT_DELAY_MS = 300;
const CSS_DELAY_MS = 300;
const IMAGE_DELAY_MS = 100;

const hero = noisePng(HERO_PX, 11);
const HERO_RULE = `.hero { background-image: url(/img/hero.png); }`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The hero is a CSS background, which neither the HTML parser nor the preload
// scanner can see. On the slow page the rule that names it lives in a
// stylesheet the app's (deferred) script injects, so the image request waits
// for the script, then for the stylesheet: three round trips in a row. The
// fixed page states the rule inline and preloads the image from <head>, so
// the image request starts with the HTML.
const head: Record<Variant, string> = {
  slow: `<script src="/static/app.js" defer></script>`,
  fixed: `<link rel="preload" as="image" href="/img/hero.png" fetchpriority="high">
<style>${HERO_RULE}</style>
<script src="/static/app.js" defer></script>`,
};

const appJs: Record<Variant, string> = {
  slow: `(function () {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/static/hero.css";
  document.head.appendChild(link);
  document.getElementById("status").textContent = "app ready";
})();`,
  fixed: `document.getElementById("status").textContent = "app ready";`,
};

export default definePattern({
  id: "late-discovered-lcp",
  title: "LCP image discovered late (CSS background from injected stylesheet)",
  category: "network",
  description: `The hero, the page's LCP element, is a CSS background image named in a stylesheet that the app's script adds at runtime. The browser cannot know about the image until the script has loaded (${SCRIPT_DELAY_MS} ms) and the stylesheet has loaded (${CSS_DELAY_MS} ms), so the image request only starts after two round trips, and LCP lands after three.`,
  fix: 'Make the LCP image discoverable from the HTML: an <img> (with fetchpriority="high"), or <link rel="preload" as="image"> plus the background rule inline in the critical CSS.',
  routes: (variant) => ({
    "/": html(
      page(
        "Resort",
        `<div class="hero"></div>
<h1>Sea view resort</h1>
<p id="status">loading…</p>`,
        `<style>
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; }
  .hero { width: ${HERO_PX}px; height: ${HERO_PX}px; background: #ddd no-repeat; }
  h1, p { padding: 0 16px; }
</style>
${head[variant]}`,
      ),
    ),
    "/static/app.js": handler(async (_req, res) => {
      await sleep(SCRIPT_DELAY_MS);
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(appJs[variant]);
    }),
    "/static/hero.css": handler(async (_req, res) => {
      await sleep(CSS_DELAY_MS);
      res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
      res.end(HERO_RULE);
    }),
    "/img/hero.png": handler(async (_req, res) => {
      await sleep(IMAGE_DELAY_MS);
      res.writeHead(200, { "content-type": "image/png", "content-length": hero.length, "cache-control": "no-store" });
      res.end(hero);
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
    // slow: script (300 ms), then stylesheet (300 ms), then image (100 ms), ~750 ms;
    // fixed: the preloaded image arrives with the first paint, ~150 ms.
    minImprovement: { ratio: 2.5, absolute: 300 },
  },
});
