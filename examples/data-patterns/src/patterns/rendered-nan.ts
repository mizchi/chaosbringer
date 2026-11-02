import { definePattern, html, json, page, type Variant } from "../pattern.js";

// Both pages multiply price by quantity. The buggy page formats the product
// whatever it is; the fixed one shows it only when it is a finite number.
const total: Record<Variant, string> = {
  buggy: `
      totalEl.textContent = "Total: " + (data.price * data.qty).toFixed(2) + " EUR";`,
  fixed: `
      const total = data.price * data.qty;
      totalEl.textContent = Number.isFinite(total) ? "Total: " + total.toFixed(2) + " EUR" : "Total unavailable";`,
};

export default definePattern({
  id: "rendered-nan",
  title: "Arithmetic on a price that arrived as a localized string",
  category: "bug-data",
  description:
    'The cart page shows price × quantity. The cart endpoint sends the price as a localized string ("12,5"), which the multiplication coerces to NaN, and NaN.toFixed(2) is the text "NaN": the total reads "Total: NaN EUR". Nothing throws, so no error is reported; only the rendered text shows it.',
  fix: "Check that a computed number is finite (Number.isFinite) before rendering it, and show a fallback when it isn't; parse money at the boundary, not by implicit coercion.",
  realism: "Prices and quantities serialized as locale-formatted strings, decimal columns that a driver returns as strings, a CSV import with comma decimals.",
  routes: (variant) => ({
    "/": html(
      page(
        "Cart",
        `<h1>Cart</h1>
<p id="total">Loading…</p>
<script>
    const totalEl = document.getElementById("total");
    async function load() {
      const res = await fetch("/api/cart");
      const data = await res.json();${total[variant]}
    }
    load();
</script>`,
      ),
    ),
    "/api/cart": json({ price: 12.5, qty: 2 }),
  }),
  inject: {
    channel: "response",
    path: "/api/cart",
    bad: '{"price":"12,5","qty":2}',
    benign: '{"price":12.5,"qty":2}',
  },
  expect: {
    signal: { kind: "invariant", name: "data.rendered-garbage" },
    fixedText: /Total unavailable/,
  },
});
