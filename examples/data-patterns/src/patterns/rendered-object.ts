import { definePattern, html, json, page, type Variant } from "../pattern.js";

// Both pages list the post's tags. The buggy page lets concatenation turn
// `tags` into text, which reads well only for an array; the fixed one renders
// only an array of strings.
const tags: Record<Variant, string> = {
  buggy: `
      tagsEl.textContent = "Tags: " + data.tags;`,
  fixed: `
      const tags = Array.isArray(data.tags) ? data.tags.filter((t) => typeof t === "string") : [];
      tagsEl.textContent = tags.length > 0 ? "Tags: " + tags.join(", ") : "No tags";`,
};

export default definePattern({
  id: "rendered-object",
  title: "An object concatenated into text",
  category: "bug-data",
  description:
    'The post page shows "Tags: " + post.tags, which reads "a,b" for an array. The posts endpoint starts sending tags as a map of tag to count ({ "a": 1 }), and concatenation calls the object\'s toString: the page reads "Tags: [object Object]". Nothing throws, so no error is reported; only the rendered text shows it.',
  fix: "Check the shape before rendering (Array.isArray, and that each item is a string) and join the items yourself; never let concatenation stringify a value whose type you haven't checked.",
  realism: "An API that changes a list to a map (tag counts, ids keyed by name), or sends one item instead of a one-item list.",
  routes: (variant) => ({
    "/": html(
      page(
        "Post",
        `<h1>Post</h1>
<p id="tags">Loading…</p>
<script>
    const tagsEl = document.getElementById("tags");
    async function load() {
      const res = await fetch("/api/post");
      const data = await res.json();${tags[variant]}
    }
    load();
</script>`,
      ),
    ),
    "/api/post": json({ tags: ["a", "b"] }),
  }),
  inject: {
    channel: "response",
    path: "/api/post",
    bad: '{"tags":{"a":1}}',
    benign: '{"tags":["a","b"]}',
  },
  expect: {
    signal: { kind: "invariant", name: "data.rendered-garbage" },
    fixedText: /No tags/,
  },
});
