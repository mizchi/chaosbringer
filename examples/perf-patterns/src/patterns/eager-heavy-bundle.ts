import { definePattern, handler, html, page, type Variant } from "../pattern.js";

// A charting library the page only needs when someone clicks "Show chart".
// Its module does its setup at import time: it builds lookup tables (the
// stand-in for the parse, compile and initialisation cost of a large
// dependency). The slow page imports it statically, so every page load pays
// for it before the page is interactive. The fixed page import()s it on the
// first click, so the load does not run it at all.
const CHART_JS = `
const TABLE_SIZE = 1200000;
const sin = new Float64Array(TABLE_SIZE);
const palette = [];
for (let i = 0; i < TABLE_SIZE; i++) {
  sin[i] = Math.sin((i / TABLE_SIZE) * Math.PI * 2);
  if (i % 50 === 0) palette.push("hsl(" + (i % 360) + ", 60%, " + (40 + (i % 20)) + "%)");
}
const glyphs = new Map();
for (let i = 0; i < 180000; i++) glyphs.set("g" + i, { w: (i * 7) % 13, h: (i * 11) % 17, path: "M0 0L" + i + " " + (i % 97) });
export function drawChart(el, values) {
  el.innerHTML = values
    .map((v, i) => '<div class="bar" style="width:' + Math.round(v * 3) + 'px;background:' + palette[i % palette.length] + '"></div>')
    .join("");
  return sin.length + glyphs.size;
}
`;

const APP_JS: Record<Variant, string> = {
  slow: `import { drawChart } from "/js/chart.js";
document.getElementById("show").addEventListener("click", () => {
  drawChart(document.getElementById("chart"), [42, 17, 88, 63, 29]);
});`,
  fixed: `document.getElementById("show").addEventListener("click", async () => {
  const { drawChart } = await import("/js/chart.js");
  drawChart(document.getElementById("chart"), [42, 17, 88, 63, 29]);
});`,
};

const js = (body: string) =>
  handler((_req, res) => {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  });

export default definePattern({
  id: "eager-heavy-bundle",
  title: "Heavy module evaluated on load, used on click",
  category: "main-thread",
  description:
    "The page imports its charting library statically, although the chart only appears after a click. The library does its setup when it is imported (lookup tables, a glyph cache), so every page load runs that script on the main thread before the page settles, for a feature most visitors never open.",
  fix: "Load the feature on demand: import() it in the click handler (or on idle / when its section scrolls near), so the page load only runs the code the first view needs.",
  routes: (variant) => ({
    "/": html(
      page(
        "Sales",
        `<h1>Sales</h1>
<p>Quarter to date: $1.2M across 5 regions.</p>
<button id="show" type="button">Show chart</button>
<div id="chart"></div>`,
        `<script type="module" src="/js/app.js"></script>
<style>.bar { height: 16px; margin: 4px 0; }</style>`,
      ),
    ),
    "/js/app.js": js(APP_JS[variant]),
    "/js/chart.js": js(CHART_JS),
  }),
  crawl: {
    maxPages: 1,
    // No clicks: the load is the step under test (the fixed page would pay
    // the import on its first click instead).
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/ :: load",
    // Script time, which scales smoothly (cpu.blockingMs would read 0 or the
    // whole task depending on which side of 50 ms the setup lands).
    metric: "render.scriptMs",
    direction: "lower",
    // slow: ~240 ms running the library's setup on a dev machine. A CI runner
    // measured 23 ms for a setup a third this size, so it is sized to stay
    // past 25 ms there. fixed: ~3-6 ms (the app module alone).
    minImprovement: { ratio: 4, absolute: 25 },
  },
});
