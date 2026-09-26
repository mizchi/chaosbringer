import { definePattern, handler, html, page, type Routes, type Variant } from "../pattern.js";

// Five vendor tags, ~100 KB each, the kind a marketing page accumulates.
const TAGS = ["tag-manager", "analytics", "chat-widget", "ab-testing", "social-share"] as const;
const TAG_KB = 100;

/** A script that looks like minified vendor code: a big data blob and a tiny init. */
function vendorScript(name: string): Buffer {
  let s = name.length * 7919;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s;
  };
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let blob = "";
  while (blob.length < TAG_KB * 1024) blob += alphabet[rand() % 64];
  return Buffer.from(
    `/*! ${name} v3.2.1 */(function(){var d="${blob}";window.__vendors=(window.__vendors||[]).concat(["${name}",d.length]);})();`,
  );
}
const scripts = new Map(TAGS.map((t) => [t, vendorScript(t)]));

// Slow: every tag is fetched while the page loads. Fixed: the page shows a
// facade (a static "Chat" button, share links), and the tags load on the
// first interaction with the page.
const loader: Record<Variant, string> = {
  slow: `for (const src of TAG_URLS) {
    const s = document.createElement("script");
    s.src = src; s.async = true;
    document.head.appendChild(s);
  }`,
  fixed: `let loaded = false;
  function loadTags() {
    if (loaded) return;
    loaded = true;
    for (const src of TAG_URLS) {
      const s = document.createElement("script");
      s.src = src; s.async = true;
      document.head.appendChild(s);
    }
  }
  for (const ev of ["pointerdown", "keydown", "scroll"]) addEventListener(ev, loadTags, { once: true, passive: true });`,
};

export default definePattern({
  id: "third-party-bloat",
  title: "Third-party tags loaded up front",
  category: "network",
  description: `A landing page loads five vendor tags (tag manager, analytics, chat widget, A/B testing, share buttons) from another company's domain as it loads: ~${TAGS.length * TAG_KB} KB of script the visitor downloads, parses and runs before doing anything, most of it for widgets nobody has touched yet.`,
  fix: "Put a facade in front of widgets (a static button that loads the real one on click) and load the other tags on first interaction or idle; drop the ones nobody reads.",
  routes: (variant, { thirdPartyOrigin }) => ({
    "/": html(
      page(
        "Landing",
        `<h1>Our product</h1>
<p>It does the thing, fast.</p>
<button id="chat" type="button">Chat with us</button>
<script>
  const TAG_URLS = ${JSON.stringify(TAGS.map((t) => `${thirdPartyOrigin}/tags/${t}.js`))};
  ${loader[variant]}
</script>`,
      ),
    ),
  }),
  thirdPartyRoutes: () => {
    const routes: Routes = {};
    for (const [name, body] of scripts) {
      routes[`/tags/${name}.js`] = handler((_req, res) => {
        res.writeHead(200, {
          "content-type": "application/javascript; charset=utf-8",
          "content-length": body.length,
          "cache-control": "no-store",
        });
        res.end(body);
      });
    }
    return routes;
  },
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/ :: load",
    metric: "page.network.thirdParty.encodedKB",
    direction: "lower",
    // slow: 5 × ~100 KB from localhost (third-party to 127.0.0.1); fixed: none on load.
    // perfPage leaves network.thirdParty out when there was no third-party request.
    absentAs: 0,
    minImprovement: { ratio: 5, absolute: 300 },
    alsoExpect: [
      {
        metric: "page.network.thirdParty.requestCount",
        direction: "lower",
        absentAs: 0,
        minImprovement: { absolute: 4 },
      },
    ],
  },
});
