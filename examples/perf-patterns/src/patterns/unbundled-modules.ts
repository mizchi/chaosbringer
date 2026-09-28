import { definePattern, handler, html, page, type Variant } from "../pattern.js";

const MODULES = 60;
const MODULE_DELAY_MS = 50;

// A client-rendered dashboard built from 60 small ES modules (one widget
// each), shipped as they are in the source tree. main.js imports all of them
// directly, so the graph is one level deep and every import is known as soon
// as main.js is parsed: the browser requests the 60 files at once. That is
// breadth, not depth (module-import-chain is the depth case, which
// modulepreload fixes); here the cost is the number of requests. Each one
// pays the server's per-request time (~50 ms here: routing, auth, a cold
// file read), and over HTTP/1.1 Chrome opens at most six connections per
// host, so the 60 requests queue in about ten rounds before main.js can run
// and render. The fixed page serves the same code bundled into one file.
const widget = (i: number) =>
  `export function widget${i}() { return '<li class="w">Widget ${i + 1}: ' + (${i} * 17 % 100) + '%</li>'; }`;

const mainModule = [
  ...Array.from({ length: MODULES }, (_, i) => `import { widget${i} } from "./widgets/w${i}.js";`),
  `document.getElementById("app").innerHTML = "<h1>Dashboard</h1><ul>" + [${Array.from({ length: MODULES }, (_, i) => `widget${i}`).join(", ")}].map((w) => w()).join("") + "</ul>";`,
].join("\n");

// The same code as one module, as a bundler would emit it.
const bundle = [
  ...Array.from({ length: MODULES }, (_, i) => widget(i).replace(/^export /, "")),
  mainModule.split("\n").slice(MODULES).join("\n"),
].join("\n");

const js = (body: string) =>
  handler(async (_req, res) => {
    await new Promise((r) => setTimeout(r, MODULE_DELAY_MS));
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  });

const entry: Record<Variant, string> = {
  slow: "/js/main.js",
  fixed: "/js/bundle.js",
};

export default definePattern({
  id: "unbundled-modules",
  title: "Dozens of unbundled ES modules requested on load",
  category: "network",
  description: `The dashboard ships its ${MODULES} source modules unbundled: main.js imports them all, so the page makes ${MODULES + 1} script requests before it can render. They are discovered at once, but each costs a round trip and the server's per-request time (${MODULE_DELAY_MS} ms), and over HTTP/1.1 the browser runs at most six per host at a time, so they queue in about ten rounds and the page stays blank until the last one lands.`,
  fix: "Bundle the modules for production (Vite/Rollup/esbuild), splitting by route or feature into a few chunks rather than one file per source module; HTTP/2 lifts the six-connection limit but not the per-request cost.",
  routes: (variant) => ({
    "/": html(page("Dashboard", `<div id="app"></div>`, `<script type="module" src="${entry[variant]}"></script>`)),
    // Both variants serve every file (same paths); each page loads only its own.
    "/js/main.js": js(mainModule),
    "/js/bundle.js": js(bundle),
    ...Object.fromEntries(Array.from({ length: MODULES }, (_, i) => [`/js/widgets/w${i}.js`, js(widget(i))])),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/ :: load",
    // An exact count: the document and its scripts.
    metric: "network.requestCount",
    direction: "lower",
    // slow: 62 (document, main.js, 60 widgets); fixed: 2.
    minImprovement: { ratio: 10, absolute: 50 },
    alsoExpect: [
      {
        // Nothing paints before main.js renders, so FCP waits for the last module.
        metric: "page.vitals.FCP.value",
        direction: "lower",
        // slow: ~700 ms (main.js, then ~ten rounds of ~50 ms); fixed: ~90 ms (one file).
        minImprovement: { ratio: 2, absolute: 200 },
      },
    ],
  },
});
