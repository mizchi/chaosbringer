import { definePattern, html, page, type Variant } from "../pattern.js";

const ROWS = 400;

// "Open report" renders a fresh 400-row report table (about 2,800 DOM nodes)
// into the panel, replacing the previous one. Both variants take the old
// table out of the document. The slow one also pushes it onto a `backStack`
// array "so Back can restore it", which nothing ever reads: every replaced
// table stays alive as a detached DOM tree. The fixed one keeps the small
// data it would need to re-render instead of the nodes.
const replace: Record<Variant, string> = {
  slow: `
      const old = panel.firstElementChild;
      if (old) backStack.push(old);
      panel.replaceChildren(table);`,
  fixed: `
      backStack.push({ generation });
      panel.replaceChildren(table);`,
};

export default definePattern({
  id: "detached-dom-leak",
  title: "Detached DOM trees kept alive by a reference",
  category: "memory",
  description: `Each "Open report" click swaps in a new ${ROWS}-row table and removes the old one from the page, but the old table is also pushed onto a back-stack array that is never read. A node out of the document is only freed when nothing references it, so every replaced table (~2,800 nodes) stays in memory as a detached DOM tree, and the page's node count climbs with every click.`,
  fix: "Do not hold on to removed DOM: keep the data you need to rebuild it (or a WeakRef / WeakMap keyed by live nodes), and clear caches of elements when their view unmounts.",
  routes: (variant) => ({
    "/": html(
      page(
        "Reports",
        `<h1>Reports</h1>
<button id="open" type="button">Open report</button>
<div id="panel"></div>
<script>
    const panel = document.getElementById("panel");
    const backStack = [];
    let generation = 0;
    document.getElementById("open").addEventListener("click", () => {
      const n = ++generation;
      const table = document.createElement("table");
      const rows = [];
      for (let i = 0; i < ${ROWS}; i++) {
        rows.push("<tr><td>" + (i + 1) + "</td><td>Region " + (i % 12) + "</td><td>" + ((i * 37 + n) % 1000) + "</td></tr>");
      }
      table.innerHTML = "<tbody>" + rows.join("") + "</tbody>";
${replace[variant]}
    });
</script>`,
        `<style>td { padding: 1px 6px; border-bottom: 1px solid #eee; font: 13px/1.3 sans-serif; }</style>`,
      ),
    ),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 6,
    seed: 1,
    // Only the button: every action is a click on it.
    actionWeights: { scroll: 0 },
    // Retained nodes only: GC at span boundaries, so a replaced table that is
    // garbage (the fixed variant's) is collected before the reading.
    perf: { memory: { forceGc: true } },
  },
  expect: {
    key: "/ :: click *",
    // Live DOM nodes after the click (post-GC). Not render.nodes: that delta is
    // read before the GC, so it counts the fixed variant's garbage too.
    metric: "memory.domNodes",
    direction: "lower",
    // slow: one more ~2,800-node table per click (2.8k, 5.6k ... 16.8k over
    // clicks 1..6, median ~9.8k); fixed: the current table alone, ~2.8k.
    minImprovement: { ratio: 2, absolute: 3000 },
  },
});
