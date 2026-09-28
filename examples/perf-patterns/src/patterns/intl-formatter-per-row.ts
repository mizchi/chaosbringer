import { definePattern, html, page, type Variant } from "../pattern.js";

const ROWS = 2000;

// An orders table: "Show orders" draws 2,000 rows, each with a price and a
// date in the user's locale. Both pages build the same rows with the same
// DOM calls; they differ only in how they format the two cells.
//
// The slow page constructs an Intl.NumberFormat and an Intl.DateTimeFormat
// for every cell (the shape of a formatPrice(n) helper that does
// `new Intl.NumberFormat(locale, opts).format(n)`, or of
// n.toLocaleString(locale, opts), which does the same inside). Building a
// formatter resolves the locale and its data (numbering system, currency
// digits, calendar, patterns), which costs far more than formatting one
// value. The fixed page builds each formatter once and reuses it.
const formatters: Record<Variant, string> = {
  slow: `
    const price = (n) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
    const date = (t) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(t);`,
  fixed: `
    const priceFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
    const dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
    const price = (n) => priceFmt.format(n);
    const date = (t) => dateFmt.format(t);`,
};

export default definePattern({
  id: "intl-formatter-per-row",
  title: "A new Intl formatter for every cell",
  category: "main-thread",
  description: `Clicking "Show orders" takes a noticeable pause to draw a ${ROWS.toLocaleString("en-US")}-row table. Each row's price and date go through helpers that construct a new Intl.NumberFormat / Intl.DateTimeFormat per call; building a formatter resolves the locale's data and costs far more than formatting a value, so the table pays it ${(ROWS * 2).toLocaleString("en-US")} times.`,
  fix: "Create each Intl formatter once per locale and options (a module-level constant or a small cache keyed by them) and call .format() on it; avoid toLocaleString(locale, options) in loops, which builds one per call.",
  routes: (variant) => ({
    "/": html(
      page(
        "Orders",
        `<h1>Orders</h1>
<button id="show" type="button">Show orders</button>
<table><tbody id="rows"></tbody></table>
<script>
    ${formatters[variant]}
    const orders = Array.from({ length: ${ROWS} }, (_, i) => ({
      id: 10000 + i,
      total: ((i * 7919) % 100000) / 100,
      placedAt: 1700000000000 + i * 3600000,
    }));
    document.getElementById("show").addEventListener("click", () => {
      const tbody = document.getElementById("rows");
      const frag = document.createDocumentFragment();
      for (const o of orders) {
        const tr = document.createElement("tr");
        tr.append(cell("#" + o.id), cell(price(o.total)), cell(date(o.placedAt)));
        frag.append(tr);
      }
      tbody.replaceChildren(frag);
    });
    function cell(text) {
      const td = document.createElement("td");
      td.textContent = text;
      return td;
    }
</script>`,
        `<style>body { font: 14px/1.4 system-ui, sans-serif; } td { padding: 1px 8px; }</style>`,
      ),
    ),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 2,
    seed: 1,
    actionWeights: { scroll: 0 },
  },
  expect: {
    key: "/ :: click *",
    metric: "render.scriptMs",
    direction: "lower",
    // slow: ~245 ms (4,000 formatters built); fixed: ~20 ms (the same
    // 6,000 cells created and 4,000 values formatted by two formatters).
    minImprovement: { ratio: 5, absolute: 100 },
  },
});
