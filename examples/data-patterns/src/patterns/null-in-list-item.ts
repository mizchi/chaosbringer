import { definePattern, html, json, page, type Variant } from "../pattern.js";

// Both pages list the team's display names, trimmed. The buggy page trims
// every name as if each item had one; the fixed one treats a name as nullable
// and labels the item that has none.
const show: Record<Variant, string> = {
  buggy: `
      list.replaceChildren(...data.items.map((item) => li(item.name.trim())));`,
  fixed: `
      list.replaceChildren(...data.items.map((item) => li((item.name ?? "").trim() || "Unnamed member")));`,
};

export default definePattern({
  id: "null-in-list-item",
  title: "A null field in one item of a list",
  category: "bug-data",
  description:
    "The team page renders item.name.trim() for every member. One member never set a display name, the API sends { name: null } for them, and reading .trim off null throws inside the async loader: the whole list stays on its loading text, not just that row, and the rejection escapes unhandled.",
  fix: "Treat the field as nullable on every item where it is read (a null check or ?? with a fallback label) and render the item anyway.",
  realism: "Nullable columns in list endpoints (a display name, an avatar, a title never filled in), LEFT JOINs that find no row for some items, records imported from another system.",
  routes: (variant) => ({
    "/": html(
      page(
        "Team",
        `<h1>Team</h1>
<ul id="members"><li>Loading…</li></ul>
<script>
    const list = document.getElementById("members");
    const li = (text) => Object.assign(document.createElement("li"), { textContent: text });
    async function load() {
      const res = await fetch("/api/items");
      const data = await res.json();${show[variant]}
    }
    load();
</script>`,
      ),
    ),
    "/api/items": json({ items: [{ name: "a" }, { name: "b" }] }),
  }),
  inject: {
    channel: "response",
    path: "/api/items",
    bad: '{"items":[{"name":"a"},{"name":null}]}',
    benign: '{"items":[{"name":"a"},{"name":"b"}]}',
  },
  expect: {
    signal: { kind: "error", message: /reading 'trim'/ },
    fixedText: /Unnamed member/,
  },
});
