import { definePattern, handler, html, page, type Variant } from "../pattern.js";

const MODULE_DELAY_MS = 200;

// A client-rendered app: the HTML is an empty shell and main.js renders the
// page. main.js imports the router, which imports the store, which imports the
// api client. The browser learns of each import only when the module that has
// it arrives and is parsed, so the four downloads run in series before
// anything can render. The fixed page lists the whole graph with
// <link rel="modulepreload">, so all four download at once.
const MODULES = ["main", "router", "store", "api"] as const;

const source: Record<(typeof MODULES)[number], string> = {
  main: `import { routes } from "./router.js";
document.getElementById("app").innerHTML =
  "<h1>Inbox</h1>" + routes().map((r) => "<p>" + r + "</p>").join("");`,
  router: `import { messages } from "./store.js";
export const routes = () => messages().map((m) => "From " + m.from + ": " + m.subject);`,
  store: `import { fetchAll } from "./api.js";
export const messages = () => fetchAll();`,
  api: `export const fetchAll = () => Array.from({ length: 8 }, (_, i) => ({ from: "user" + (i + 1), subject: "Weekly sync notes, part " + (i + 1) }));`,
};

const preload: Record<Variant, string> = {
  slow: "",
  fixed: MODULES.map((m) => `<link rel="modulepreload" href="/js/${m}.js">`).join("\n"),
};

export default definePattern({
  id: "module-import-chain",
  title: "ES module import waterfall",
  category: "network",
  description: `The page is rendered by an ES module whose imports go four deep (main → router → store → api). Each import is discovered only after the module that contains it has downloaded, so the ${MODULE_DELAY_MS} ms requests run one after another and the page stays blank for their sum before the first line renders.`,
  fix: 'List the module graph up front with <link rel="modulepreload"> (bundlers emit these), or bundle the modules on the critical path into one file.',
  routes: (variant) => ({
    "/": html(page("Inbox", `<div id="app"></div>`, `${preload[variant]}\n<script type="module" src="/js/main.js"></script>`)),
    ...Object.fromEntries(
      MODULES.map((name) => [
        `/js/${name}.js`,
        handler(async (_req, res) => {
          await new Promise((r) => setTimeout(r, MODULE_DELAY_MS));
          res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
          res.end(source[name]);
        }),
      ]),
    ),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/ :: load",
    // Nothing paints before main.js renders, so FCP is when the chain is done.
    metric: "page.vitals.FCP.value",
    direction: "lower",
    // slow: four modules in series (~4 × 200 ms); fixed: in parallel (~200 ms).
    minImprovement: { ratio: 2.5, absolute: 350 },
  },
});
