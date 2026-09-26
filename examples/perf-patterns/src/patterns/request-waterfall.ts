import { definePattern, html, json, page, type Variant } from "../pattern.js";

const DELAY_MS = 80;
const PARTS = ["profile", "settings", "notifications", "stats"] as const;

// Both variants load the same four independent resources. The slow one awaits
// each before starting the next, as if each depended on the one before; the
// fixed one starts them together.
const loaders: Record<Variant, string> = {
  slow: `
    async function load() {
      const out = {};
      for (const part of ${JSON.stringify(PARTS)}) {
        out[part] = await (await fetch("/api/" + part)).json();
      }
      return out;
    }`,
  fixed: `
    async function load() {
      const parts = ${JSON.stringify(PARTS)};
      const values = await Promise.all(parts.map(async (p) => (await fetch("/api/" + p)).json()));
      return Object.fromEntries(parts.map((p, i) => [p, values[i]]));
    }`,
};

export default definePattern({
  id: "request-waterfall",
  title: "Request waterfall on load",
  category: "network",
  description:
    "The dashboard awaits four independent API calls one after another. Each takes ~80 ms on the server, so the page waits ~320 ms for data it could have had in ~80 ms: a waterfall of four serial waves.",
  fix: "Start independent requests together (Promise.all), or have the server return them in one response.",
  routes: (variant) => ({
    "/": html(
      page(
        "Dashboard",
        `<h1>Dashboard</h1>
<pre id="out">Loading…</pre>
<script>${loaders[variant]}
    load().then((data) => { document.getElementById("out").textContent = JSON.stringify(data, null, 2); });
</script>`,
      ),
    ),
    ...Object.fromEntries(PARTS.map((p) => [`/api/${p}`, json({ part: p, ok: true }, { delayMs: DELAY_MS })])),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/ :: load",
    metric: "network.waves",
    direction: "lower",
    // slow: document + 4 serial fetches = 5 waves; fixed: document + 1 parallel wave = 2.
    // effectiveMs / settledMs follow: ~4×80 ms of API time vs ~80 ms.
    minImprovement: { ratio: 2, absolute: 2 },
  },
});
