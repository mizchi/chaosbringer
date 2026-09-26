import { definePattern, html, page, type Variant } from "../pattern.js";

const CARDS = 1200;

// A board of 1,200 cards, 6 elements each (~7,200 elements). The "Dark toolbar"
// button restyles the toolbar only. The slow variant does it by toggling a
// class on <body>, and its stylesheet hangs broad descendant, sibling and
// :has() rules off that class, so every toggle invalidates and re-matches
// the whole tree. The fixed variant toggles a class on the toolbar and its
// rules are scoped to that class, so only the toolbar's few elements restyle.
const cards = Array.from(
  { length: CARDS },
  (_, i) =>
    `<div class="card"><span class="title">Task ${i + 1}</span><span class="tag">todo</span><span class="who">@user${i % 17}</span><p><span>Due in ${(i % 9) + 1} days</span></p></div>`,
).join("\n");

const styles: Record<Variant, string> = {
  slow: `
  body.dark .toolbar { background: #222; color: #eee; }
  body.dark .toolbar button { background: #444; color: #eee; }
  body.dark * { outline-color: #888; }
  body.dark div span:nth-child(odd) ~ * { color: #ccc; }
  body.dark div > span:nth-child(2n+1) + span { letter-spacing: 0; }
  body.dark div:has(> span.tag) { border-color: #555; }
  body.dark div:has(p span) span { text-decoration-color: #999; }
  body.dark :not(button):not(h1) span:not(.title):not(.who) { caret-color: auto; }
  body.dark div p span:first-child:last-child { font-style: normal; }
  body.dark [class] > * ~ * { word-spacing: 0; }`,
  fixed: `
  .toolbar.dark { background: #222; color: #eee; }
  .toolbar.dark button { background: #444; color: #eee; }`,
};

const toggles: Record<Variant, string> = {
  slow: `document.body.classList.toggle("dark");`,
  fixed: `document.getElementById("toolbar").classList.toggle("dark");`,
};

export default definePattern({
  id: "expensive-selectors",
  title: "Theme class on <body> with costly selectors",
  category: "render",
  description:
    "Clicking \"Dark toolbar\" recolours three elements but stalls on style recalculation. The class is toggled on <body>, and the stylesheet has broad rules under it (universal descendants, sibling combinators, :has()), so the browser must re-match every one of ~7,200 elements on each toggle.",
  fix: "Toggle the class on the element that changes and scope rules to it (or use CSS custom properties); avoid universal/:has() rules keyed off <body>.",
  routes: (variant) => ({
    "/": html(
      page(
        "Board",
        `<div id="toolbar" class="toolbar"><h1>Board</h1><button id="theme" type="button">Dark toolbar</button></div>
<div id="board">${cards}</div>
<script>
    document.getElementById("theme").addEventListener("click", () => {
      ${toggles[variant]}
    });
</script>`,
        `<style>
  body { font: 14px/1.4 sans-serif; }
  .toolbar { display: flex; gap: 12px; align-items: center; padding: 4px 8px; }
  .card { display: inline-block; width: 180px; margin: 4px; padding: 4px; border: 1px solid #ddd; }
  .card span { margin-right: 4px; }
${styles[variant]}
</style>`,
      ),
    ),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 4,
    seed: 1,
    // Only the button: every action is a click on it.
    actionWeights: { scroll: 0 },
  },
  expect: {
    key: "/ :: click *",
    metric: "render.recalcStyleMs",
    direction: "lower",
    // slow ~15–40 ms of style recalc a click (median ~24), fixed ~0.1–0.2 ms
    // (the few toolbar elements). Absolute floor keeps a noisy fixed click from passing by ratio alone.
    minImprovement: { ratio: 10, absolute: 8 },
  },
});
