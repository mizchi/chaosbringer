import { definePattern, html, page, type Variant } from "../pattern.js";

const ROWS = 1000;
const STATIC_ROWS = 5000;

// "Show invoices" renders 1,000 invoice rows into a page that already shows
// a 5,000-row archive. The slow page styles them the way a runtime CSS-in-JS
// library does: each row's styles (which differ by status and by a per-row
// width) are turned into a CSS string, hashed to a class name, and injected
// as a new <style> element in <head> when first seen; every row gets its own
// class. The fixed page ships the same look as static CSS (a zero-runtime /
// extracted stylesheet): three status classes and a custom property for the
// per-row width, set inline.
//
// The expensive part is not the new rows: a change to the document's
// stylesheets invalidates the style of every element, so the next style
// pass recalculates the whole page (the 5,000 archive rows too) against the
// new rule set. The fixed page's recalc touches only the inserted rows.
const render: Record<Variant, string> = {
  slow: `
    const injected = new Set();
    function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i); return (h >>> 0).toString(36); }
    function css(rules) {
      const text = Object.entries(rules).map(([k, v]) => k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()) + ":" + v).join(";");
      const cls = "c" + hash(text);
      if (!injected.has(cls)) {
        injected.add(cls);
        const style = document.createElement("style");
        style.textContent = "." + cls + "{" + text + "}";
        document.head.appendChild(style);
      }
      return cls;
    }
    function rowHtml(inv) {
      const cls = css({
        display: "flex", gap: "8px", padding: "2px 4px",
        borderLeft: "4px solid " + COLORS[inv.status],
        background: inv.status === "overdue" ? "#fff4f4" : "transparent",
        width: (300 + inv.id % 1000 / 4) + "px",
      });
      return '<li class="' + cls + '"><b>#' + inv.id + '</b> <span>' + inv.status + '</span> <span>$' + inv.amount + '</span></li>';
    }`,
  fixed: `
    function rowHtml(inv) {
      return '<li class="inv inv-' + inv.status + '" style="--w:' + (300 + inv.id % 1000 / 4) + 'px"><b>#' + inv.id + '</b> <span>' + inv.status + '</span> <span>$' + inv.amount + '</span></li>';
    }`,
};

export default definePattern({
  id: "runtime-style-injection",
  title: "CSS-in-JS runtime injects a <style> per rendered row",
  category: "render",
  description: `Rendering ${ROWS.toLocaleString("en-US")} invoice rows costs far more than the rows themselves. Each row's styles are computed at runtime, hashed to a class and injected as a new <style> element, so one render adds a thousand stylesheets; a change to the page's stylesheets invalidates the style of every element, so the browser recalculates the whole page (its ${STATIC_ROWS.toLocaleString("en-US")}-row archive included) against the new rules, not just the new rows.`,
  fix: "Extract the styles at build time (static CSS, CSS Modules, a zero-runtime CSS-in-JS such as vanilla-extract or Linaria); express per-item values as CSS custom properties or a few variant classes, not one generated rule per value.",
  routes: (variant) => ({
    "/": html(
      page(
        "Invoices",
        `<h1>Invoices</h1>
<button id="show" type="button">Show invoices</button>
<ul id="archive">${Array.from({ length: STATIC_ROWS }, (_, i) => `<li class="old"><b>#A${i + 1}</b> <span>archived</span></li>`).join("")}</ul>
<ul id="list"></ul>
<script>
    const COLORS = { paid: "#2a2", open: "#28c", overdue: "#c22" };
    const STATUSES = Object.keys(COLORS);
    let shown = 0;
    ${render[variant]}
    document.getElementById("show").addEventListener("click", () => {
      const invoices = Array.from({ length: ${ROWS} }, (_, i) => ({ id: ++shown, status: STATUSES[shown % 3], amount: (shown * 37) % 997 }));
      document.getElementById("list").innerHTML = invoices.map(rowHtml).join("");
    });
</script>`,
        `<style>
  body { font: 14px/1.4 system-ui, sans-serif; }
  ul { list-style: none; padding: 0; }
  .old { color: #888; }
  .inv { display: flex; gap: 8px; padding: 2px 4px; width: var(--w); }
  .inv-paid { border-left: 4px solid #2a2; }
  .inv-open { border-left: 4px solid #28c; }
  .inv-overdue { border-left: 4px solid #c22; background: #fff4f4; }
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
    // Style recalc time: the whole page against the grown rule set, against
    // the new rows only. (render.scriptMs, building and hashing the CSS
    // strings, differs too, ~25 ms against ~10 ms, but by too little to gate.)
    metric: "render.recalcStyleMs",
    direction: "lower",
    // slow: ~185 ms a click; fixed: ~23 ms (1,000 new rows, each with an
    // inline custom property; ~6 ms without one).
    minImprovement: { ratio: 4, absolute: 80 },
  },
});
