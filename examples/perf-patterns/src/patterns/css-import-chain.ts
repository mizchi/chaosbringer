import { definePattern, handler, html, page, type Variant } from "../pattern.js";

const CSS_DELAY_MS = 250;

// Three stylesheets, each answering after the same delay. The slow page links
// only the first, which @imports the second, which @imports the third: the
// browser finds each one only after the previous has arrived and been parsed,
// so the three downloads run one after another and first paint (blocked on
// all of them) waits for the sum. The fixed page links all three from the
// HTML, and they download side by side.
const SHEETS = ["base", "theme", "components"] as const;

const rules: Record<(typeof SHEETS)[number], string> = {
  base: "body { margin: 0; padding: 0 16px; font: 16px/1.5 system-ui, sans-serif; }",
  theme: "h1 { color: #1e3a8a; } a { color: #2563eb; }",
  components: ".card { border: 1px solid #ddd; border-radius: 6px; padding: 8px 12px; margin: 8px 0; }",
};

const sheet = (variant: Variant, i: number): string => {
  const name = SHEETS[i]!;
  const next = SHEETS[i + 1];
  return variant === "slow" && next ? `@import url("/css/${next}.css");\n${rules[name]}` : rules[name];
};

const links: Record<Variant, string> = {
  slow: `<link rel="stylesheet" href="/css/base.css">`,
  fixed: SHEETS.map((s) => `<link rel="stylesheet" href="/css/${s}.css">`).join("\n"),
};

export default definePattern({
  id: "css-import-chain",
  title: "Stylesheets chained with @import",
  category: "network",
  description: `The page links one stylesheet, which @imports a second, which @imports a third. An @import is only discovered once the sheet containing it has downloaded, so the three ${CSS_DELAY_MS} ms requests run one after another, and first paint, which waits for every stylesheet, waits for all three in turn.`,
  fix: "Flatten the @imports: link every stylesheet from the HTML (or concatenate them at build time), so they download in parallel.",
  routes: (variant) => ({
    "/": html(
      page(
        "Dashboard",
        `<h1>Dashboard</h1>
${Array.from({ length: 6 }, (_, i) => `<div class="card">Widget ${i + 1}: all systems nominal.</div>`).join("\n")}`,
        links[variant],
      ),
    ),
    ...Object.fromEntries(
      SHEETS.map((name, i) => [
        `/css/${name}.css`,
        handler(async (_req, res) => {
          await new Promise((r) => setTimeout(r, CSS_DELAY_MS));
          res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
          res.end(sheet(variant, i));
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
    metric: "page.vitals.FCP.value",
    direction: "lower",
    // slow: three sheets in series (~3 × 250 ms); fixed: in parallel (~250 ms).
    minImprovement: { ratio: 2, absolute: 250 },
  },
});
