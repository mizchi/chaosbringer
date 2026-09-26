import { definePattern, html, page, type Variant } from "../pattern.js";

const ROWS = 200;

const rows = Array.from(
  { length: ROWS },
  (_, i) => `<div class="row"><span>Row ${i + 1}</span> <span>Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.</span></div>`,
).join("\n");

// Both handlers grow every row by 1px. The slow one reads offsetHeight right
// after the previous row's style write, so every read forces a synchronous
// layout (one per row). The fixed one reads all heights, then writes them all:
// one layout for the read pass, and the writes are laid out once at the next frame.
const handlers: Record<Variant, string> = {
  slow: `
    document.getElementById("grow").addEventListener("click", () => {
      for (const row of document.querySelectorAll(".row")) {
        row.style.height = row.offsetHeight + 1 + "px";
      }
      document.getElementById("status").textContent = "grown";
    });`,
  fixed: `
    document.getElementById("grow").addEventListener("click", () => {
      const list = [...document.querySelectorAll(".row")];
      const heights = list.map((row) => row.offsetHeight);
      list.forEach((row, i) => { row.style.height = heights[i] + 1 + "px"; });
      document.getElementById("status").textContent = "grown";
    });`,
};

export default definePattern({
  id: "layout-thrash",
  title: "Layout thrashing in a click handler",
  category: "render",
  description:
    "Clicking \"Grow rows\" freezes the page. The handler interleaves a style write and an offsetHeight read for each of 200 rows, so every read forces the browser to lay the page out again (forced synchronous layout).",
  fix: "Batch the reads, then the writes (or use requestAnimationFrame / fastdom).",
  routes: (variant) => ({
    "/": html(
      page(
        "Rows",
        `<h1>Rows</h1>
<button id="grow" type="button">Grow rows</button>
<p id="status"></p>
<div id="list">${rows}</div>
<script>${handlers[variant]}</script>`,
        `<style>.row { padding: 2px 4px; border-bottom: 1px solid #ddd; font: 14px/1.4 sans-serif; }</style>`,
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
    metric: "render.layoutCount",
    direction: "lower",
    // slow reads ~200 layouts a click, fixed ~1–2.
    minImprovement: { ratio: 10, absolute: 100 },
  },
});
