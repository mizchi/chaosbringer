import { definePattern, html, json, page, type Variant } from "../pattern.js";

// Both pages list the items' titles. The buggy page maps over `items` as if it
// were always an array; the fixed one wraps a lone item in one, so one result
// and many render the same way.
const show: Record<Variant, string> = {
  buggy: `
      list.replaceChildren(...data.items.map((item) => li(item.title)));`,
  fixed: `
      const items = Array.isArray(data.items) ? data.items : data.items == null ? [] : [data.items];
      list.replaceChildren(...(items.length ? items.map((item) => li(item.title)) : [li("No items yet.")]));`,
};

export default definePattern({
  id: "array-became-object",
  title: "A one-element list that arrives as a bare object",
  category: "bug-data",
  description:
    "The list page renders data.items.map(...). When there is exactly one item, the upstream collapses the list into that item, so data.items is an object, map is not a method of it, and the call throws inside the async loader: the list stays on its loading text and the rejection escapes unhandled.",
  fix: "Normalize the field to an array where it enters (Array.isArray, wrapping a lone item, an empty list for a missing one) or reject the shape with a schema, and render the empty state.",
  realism: "XML-to-JSON bridges that turn a repeated element seen once into a single object (xml2js with explicitArray off, SOAP gateways), and APIs that return the item itself when a query matches one.",
  routes: (variant) => ({
    "/": html(
      page(
        "Items",
        `<h1>Items</h1>
<ul id="items"><li>Loading…</li></ul>
<script>
    const list = document.getElementById("items");
    const li = (text) => Object.assign(document.createElement("li"), { textContent: text });
    async function load() {
      const res = await fetch("/api/items");
      const data = await res.json();${show[variant]}
    }
    load();
</script>`,
      ),
    ),
    "/api/items": json({ items: [{ id: 1, title: "A" }] }),
  }),
  inject: {
    channel: "response",
    path: "/api/items",
    bad: '{"items":{"id":1,"title":"A"}}',
    benign: '{"items":[{"id":1,"title":"A"}]}',
  },
  expect: {
    signal: { kind: "error", message: /map is not a function/ },
    // The lone item is normalized into a one-element list and its title shown.
    fixedText: /\bA\b/,
  },
});
