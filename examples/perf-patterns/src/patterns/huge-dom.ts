import { definePattern, html, page, type Variant } from "../pattern.js";

const TOTAL = 5000;
const PAGE_SIZE = 50;

// Both variants get the same 5,000 orders inline and render them into the same
// table on load. The slow one renders every row; the fixed one renders one
// page of 50 and a pager that re-renders the tbody on demand.
const renderers: Record<Variant, string> = {
  slow: `
    function render() {
      const body = document.getElementById("rows");
      const frag = document.createDocumentFragment();
      for (const o of orders) frag.appendChild(row(o));
      body.replaceChildren(frag);
      document.getElementById("status").textContent = orders.length + " orders";
    }
    render();`,
  fixed: `
    let pageNo = 0;
    const pages = Math.ceil(orders.length / ${PAGE_SIZE});
    function render() {
      const body = document.getElementById("rows");
      const frag = document.createDocumentFragment();
      for (const o of orders.slice(pageNo * ${PAGE_SIZE}, (pageNo + 1) * ${PAGE_SIZE})) frag.appendChild(row(o));
      body.replaceChildren(frag);
      document.getElementById("status").textContent = "Page " + (pageNo + 1) + " of " + pages + " (" + orders.length + " orders)";
    }
    document.getElementById("pager").hidden = false;
    document.getElementById("prev").addEventListener("click", () => { if (pageNo > 0) { pageNo--; render(); } });
    document.getElementById("next").addEventListener("click", () => { if (pageNo < pages - 1) { pageNo++; render(); } });
    render();`,
};

export default definePattern({
  id: "huge-dom",
  title: "Rendering a 5,000-row list eagerly",
  category: "render",
  description:
    "The orders page takes long to appear and every later style or layout pass is slow. It renders all 5,000 rows (about 60,000 DOM nodes) up front, although a screen shows a few dozen; every node costs creation, style and layout, and stays in memory.",
  fix: "Paginate or virtualise the list: render only the rows in view (here one page of 50).",
  routes: (variant) => ({
    "/": html(
      page(
        "Orders",
        `<h1>Orders</h1>
<p id="status">Loading…</p>
<p id="pager" hidden><button id="prev" type="button">Previous</button> <button id="next" type="button">Next</button></p>
<table>
<thead><tr><th>#</th><th>Customer</th><th>Status</th><th>Total</th></tr></thead>
<tbody id="rows"></tbody>
</table>
<script>
    const STATUSES = ["paid", "shipped", "pending", "refunded"];
    const orders = Array.from({ length: ${TOTAL} }, (_, i) => ({
      id: i + 1,
      customer: "Customer " + ((i * 7919) % 1000),
      status: STATUSES[i % STATUSES.length],
      total: ((i * 37) % 500) + 0.99,
    }));
    function row(o) {
      const tr = document.createElement("tr");
      tr.innerHTML = "<td>" + o.id + "</td><td>" + o.customer + "</td><td><span class=\\"badge\\">" + o.status + "</span></td><td>$" + o.total.toFixed(2) + "</td>";
      return tr;
    }
${renderers[variant]}
</script>`,
        `<style>
  table { border-collapse: collapse; font: 14px/1.4 sans-serif; }
  td, th { padding: 2px 8px; border-bottom: 1px solid #ddd; text-align: left; }
  .badge { padding: 0 4px; border-radius: 3px; background: #eef; }
</style>`,
      ),
    ),
  }),
  crawl: {
    maxPages: 1,
    // The load is the step under test; no actions needed.
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/ :: load",
    metric: "render.nodes",
    direction: "lower",
    // slow adds ~60,000 nodes on load, fixed ~650 (exact counts, run to run).
    minImprovement: { ratio: 20, absolute: 20000 },
  },
});
