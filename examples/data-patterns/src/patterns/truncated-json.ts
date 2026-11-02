import { definePattern, html, json, page, type Variant } from "../pattern.js";

// Both pages parse the saved-items answer. The buggy page assumes a 200 body
// always parses; the fixed one treats a body that doesn't as a failed load.
const parse: Record<Variant, string> = {
  buggy: `
      const data = await res.json();`,
  fixed: `
      let data;
      try {
        data = await res.json();
      } catch {
        saved.textContent = "Couldn't load your saved items. Reload to try again.";
        return;
      }`,
};

export default definePattern({
  id: "truncated-json",
  title: "A response body cut off mid-JSON",
  category: "bug-data",
  description:
    "The saved-items page awaits res.json() and lists data.items. When the body is cut off partway ({\"items\":[1,2), the status is still 200 but the parse fails with a SyntaxError inside the async loader: the list stays on its loading text and the rejection escapes unhandled.",
  fix: "Treat a body that doesn't parse as a failed load, like a network error: catch the parse error and show an error state with a way to retry.",
  realism: "A proxy or load balancer cutting a response at a size or time limit, a server that fails mid-stream after sending its 200 headers, a mobile connection dropped during a chunked response.",
  routes: (variant) => ({
    "/": html(
      page(
        "Saved",
        `<h1>Saved items</h1>
<p id="saved">Loading…</p>
<script>
    const saved = document.getElementById("saved");
    async function load() {
      const res = await fetch("/api/items");${parse[variant]}
      saved.textContent = "Saved item IDs: " + data.items.join(", ");
    }
    load();
</script>`,
      ),
    ),
    "/api/items": json({ items: [1, 2, 3] }),
  }),
  inject: {
    channel: "response",
    path: "/api/items",
    bad: '{"items":[1,2',
    benign: '{"items":[1,2,3]}',
  },
  expect: {
    signal: { kind: "error", message: /JSON/ },
    fixedText: /Couldn't load your saved items/,
  },
});
