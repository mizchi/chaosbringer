import { definePattern, html, page, type Variant } from "../pattern.js";

const ROWS = 3000;

// Both pages keep the same task list in memory and draw it once on load.
// "Complete next task" marks one task done. The slow page then redraws the
// whole list from its state (the list's innerHTML, rebuilt from a template
// string), so the browser throws away 3000 rows and parses, styles and lays
// out 3000 new ones to change one row. The fixed page updates that row.
const updates: Record<Variant, string> = {
  slow: `
    document.getElementById("next").addEventListener("click", () => {
      const task = tasks.find((t) => !t.done);
      if (!task) return;
      task.done = true;
      list.innerHTML = tasks.map(row).join("");
    });`,
  fixed: `
    document.getElementById("next").addEventListener("click", () => {
      const i = tasks.findIndex((t) => !t.done);
      if (i < 0) return;
      tasks[i].done = true;
      const li = list.children[i];
      li.className = "done";
      li.firstChild.textContent = "☑";
    });`,
};

export default definePattern({
  id: "full-rerender-list",
  title: "Whole list re-rendered to change one row",
  category: "render",
  description: `Completing one task in a ${ROWS}-row list rebuilds the entire list: the click handler regenerates every row's HTML and assigns it to the list's innerHTML. One row's check mark changes, but the browser parses ${ROWS} rows, recalculates their style and lays them all out again (and any state in the old rows, focus, selection, scroll, is lost).`,
  fix: "Update only what changed: touch the one row's DOM, or render through a keyed diff (React/Vue/lit keys, a virtual list) so unchanged rows are kept.",
  routes: (variant) => ({
    "/": html(
      page(
        "Tasks",
        `<h1>Tasks</h1>
<button id="next" type="button">Complete next task</button>
<ul id="list"></ul>
<script>
    const tasks = Array.from({ length: ${ROWS} }, (_, i) => ({ id: i + 1, title: "Task " + (i + 1) + ": review the quarterly report section", done: false }));
    const row = (t) => '<li class="' + (t.done ? "done" : "") + '"><b>' + (t.done ? "☑" : "☐") + '</b> <span>' + t.title + '</span> <small>#' + t.id + '</small></li>';
    const list = document.getElementById("list");
    list.innerHTML = tasks.map(row).join("");
    ${updates[variant]}
</script>`,
        `<style>
  body { font: 14px/1.4 system-ui, sans-serif; }
  #list { list-style: none; padding: 0; }
  #list li { padding: 2px 0; border-bottom: 1px solid #eee; }
  #list li.done span { text-decoration: line-through; color: #888; }
</style>`,
      ),
    ),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 3,
    seed: 1,
    actionWeights: { scroll: 0 },
  },
  expect: {
    key: "/ :: click *",
    // The layout of 3000 new rows. (render.recalcStyleCount counts style
    // recalc passes, not elements, so it reads 2-3 on both variants.)
    metric: "render.layoutMs",
    direction: "lower",
    // slow: ~50 ms of layout per click (3000 new rows); fixed: ~1.5 ms (one row).
    minImprovement: { ratio: 5, absolute: 20 },
    alsoExpect: [
      {
        // Building and parsing 3000 rows of HTML: ~27 ms vs ~1 ms.
        metric: "render.scriptMs",
        direction: "lower",
        minImprovement: { ratio: 4, absolute: 10 },
      },
    ],
  },
});
