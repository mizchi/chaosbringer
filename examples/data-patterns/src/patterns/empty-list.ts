import { definePattern, html, json, page, type Variant } from "../pattern.js";

// Both pages headline the newest item. The buggy page reads `items[0]` as if
// the list always had one; the fixed one checks that it does and shows the
// empty state.
const show: Record<Variant, string> = {
  buggy: `
      latest.textContent = "Latest: " + data.items[0].title;`,
  fixed: `
      const [first] = data.items;
      latest.textContent = first ? "Latest: " + first.title : "Nothing published yet.";`,
};

export default definePattern({
  id: "empty-list",
  title: "The first item of a list that can be empty",
  category: "bug-data",
  description:
    "The dashboard headlines data.items[0].title. For an account with nothing in it the list is empty, items[0] is undefined, and reading .title off it throws inside the async loader: the headline stays on its loading text and the rejection escapes unhandled.",
  fix: "Check the list has an element before reading one (destructure and test it, or optional chaining with a fallback) and render the empty state.",
  realism: "New accounts, a filter or search that matches nothing, a feed emptied by moderation or retention.",
  routes: (variant) => ({
    "/": html(
      page(
        "Dashboard",
        `<h1>Dashboard</h1>
<p id="latest">Loading…</p>
<script>
    const latest = document.getElementById("latest");
    async function load() {
      const res = await fetch("/api/items");
      const data = await res.json();${show[variant]}
    }
    load();
</script>`,
      ),
    ),
    "/api/items": json({ items: [{ title: "A" }] }),
  }),
  inject: {
    channel: "response",
    path: "/api/items",
    bad: '{"items":[]}',
    benign: '{"items":[{"title":"A"}]}',
  },
  expect: {
    signal: { kind: "error", message: /reading 'title'/ },
    fixedText: /Nothing published/,
  },
});
