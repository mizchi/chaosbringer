import { definePattern, html, page, type Variant } from "../pattern.js";

const TABS = 10;
const ROWS = 400;

// A settings/report screen with ten tabs, each a table of 400 rows. Only
// one tab is visible at a time. The slow page renders every panel on load
// and hides the inactive nine with display: none (the "render all, toggle
// visibility" tabs component): display: none skips their layout and paint,
// but the script still builds all ten tables, and their DOM still exists,
// costs memory, and is restyled on every change. The fixed page renders the
// active panel only, and each other panel the first time its tab is opened.
const mount: Record<Variant, string> = {
  slow: `for (let t = 0; t < TABS; t++) panelFor(t);
    show(0);`,
  fixed: `show(0);`,
};

export default definePattern({
  id: "render-hidden-tabs",
  title: "Every tab panel rendered on load, hidden with display: none",
  category: "render",
  description: `A report screen has ${TABS} tabs, each a table of ${ROWS} rows, and shows one at a time. Its tabs component renders all ${TABS} panels up front and hides the inactive ones with display: none, so every load builds ${TABS}× the DOM the reader sees (tens of thousands of nodes) and runs the script that makes it, for tabs most readers never open.`,
  fix: "Render a tab's content when it is first opened (and keep it, or unmount it, after); frameworks' lazy tab panels (Vue's v-if over v-show, React conditional rendering, <details>/hidden=until-found for text) do this. If panels must exist up front, keep them light and fill them on open.",
  routes: (variant) => ({
    "/": html(
      page(
        "Report",
        `<h1>Quarterly report</h1>
<div id="tabs">${Array.from({ length: TABS }, (_, t) => `<button type="button" data-tab="${t}">Region ${t + 1}</button>`).join("")}</div>
<div id="panels"></div>
<script>
    const TABS = ${TABS};
    const panels = [];
    function panelFor(t) {
      if (panels[t]) return panels[t];
      const p = document.createElement("table");
      p.hidden = true;
      let rows = "";
      for (let r = 0; r < ${ROWS}; r++) {
        rows += "<tr><td>" + (r + 1) + "</td><td>Store " + (t * ${ROWS} + r) + "</td><td>" + ((r * 37 + t) % 1000) + "</td><td>" + ((r * 11) % 97) + "%</td><td>Q" + (r % 4 + 1) + "</td></tr>";
      }
      p.innerHTML = "<tbody>" + rows + "</tbody>";
      document.getElementById("panels").appendChild(p);
      return (panels[t] = p);
    }
    function show(t) {
      panels.forEach((p) => { if (p) p.hidden = true; });
      panelFor(t).hidden = false;
    }
    document.getElementById("tabs").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b) show(Number(b.dataset.tab));
    });
    ${mount[variant]}
</script>`,
        `<style>[hidden] { display: none; } td { padding: 2px 8px; }</style>`,
      ),
    ),
  }),
  crawl: {
    maxPages: 1,
    // No clicks: the load is the step under test.
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/ :: load",
    // DOM nodes the load created: exact, and independent of the machine.
    metric: "render.nodes",
    direction: "lower",
    // slow: ten tables, ~44,000 nodes; fixed: one, ~4,500.
    minImprovement: { ratio: 5, absolute: 20000 },
    alsoExpect: [
      {
        // Building the tables (innerHTML parsing runs as script): ~20–30 ms against ~4.5 ms.
        // Layout is the same on both (~16 ms): display: none panels are not laid out.
        metric: "render.scriptMs",
        direction: "lower",
        minImprovement: { ratio: 2.5, absolute: 8 },
      },
    ],
  },
});
