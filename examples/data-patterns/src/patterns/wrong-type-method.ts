import { definePattern, html, json, page, type Variant } from "../pattern.js";

// Both pages format the product's price to two decimals. The buggy page calls
// a number method on whatever arrived; the fixed one converts the field to a
// number first and checks it is one.
const show: Record<Variant, string> = {
  buggy: `
      price.textContent = "$" + data.price.toFixed(2);`,
  fixed: `
      const amount = Number(data.price);
      price.textContent = Number.isFinite(amount) ? "$" + amount.toFixed(2) : "Price unavailable";`,
};

export default definePattern({
  id: "wrong-type-method",
  title: "A number that arrives as a string",
  category: "bug-data",
  description:
    "The product page shows data.price.toFixed(2). When the backend sends the price as the string \"9.99\", toFixed is not a method of it, and the call throws inside the async loader: the price stays on its loading text and the rejection escapes unhandled.",
  fix: "Convert the field to the type the page uses where it enters (Number() and a finiteness check, or a schema that coerces) and show a fallback when it isn't one.",
  realism: "Decimal columns serialized as strings to keep their precision (Postgres numeric through node-postgres, Python's Decimal, Rails' BigDecimal), numbers read from CSV or form-encoded upstreams.",
  routes: (variant) => ({
    "/": html(
      page(
        "Product",
        `<h1>Product</h1>
<p>Price: <span id="price">Loading…</span></p>
<script>
    const price = document.getElementById("price");
    async function load() {
      const res = await fetch("/api/product");
      const data = await res.json();${show[variant]}
    }
    load();
</script>`,
      ),
    ),
    "/api/product": json({ price: 9.99 }),
  }),
  inject: {
    channel: "response",
    path: "/api/product",
    bad: '{"price":"9.99"}',
    benign: '{"price":9.99}',
  },
  expect: {
    signal: { kind: "error", message: /toFixed is not a function/ },
  },
});
