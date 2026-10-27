import { definePattern, html, json, page, type Variant } from "../pattern.js";

// Both pages show the post's comments. The buggy page drops each comment body
// into the list item with innerHTML; the fixed one sets it as text, so markup
// in a comment renders as the characters the commenter typed.
const show: Record<Variant, string> = {
  buggy: `
      list.replaceChildren(...comments.map((c) => {
        const li = document.createElement("li");
        li.innerHTML = c.body;
        return li;
      }));`,
  fixed: `
      list.replaceChildren(...comments.map((c) => {
        const li = document.createElement("li");
        li.textContent = c.body;
        return li;
      }));`,
};

export default definePattern({
  id: "stored-xss-innerhtml",
  title: "A stored comment body written with innerHTML",
  category: "malicious-data",
  description:
    "The post page lists comments, each rendered with li.innerHTML = comment.body. A comment is whatever a visitor typed, so a body that is markup becomes live markup: a <details open ontoggle> payload runs its handler as the browser inserts it, and so would an injected form or fake badge. The comment survives in the database, so it runs for every reader.",
  fix: "Put user data into the page as text (textContent, a text node, a framework's default interpolation), never into an HTML string.",
  realism: "Comments, reviews, chat messages and activity feeds stored as typed and rendered with innerHTML or a template string, the classic stored-XSS sink.",
  routes: (variant) => ({
    "/": html(
      page(
        "Post",
        `<h1>Comments</h1>
<ul id="comments"><li>Loading…</li></ul>
<script>
    const list = document.getElementById("comments");
    async function load() {
      const res = await fetch("/api/comments");
      const comments = await res.json();${show[variant]}
    }
    load();
</script>`,
      ),
    ),
    "/api/comments": json([{ body: "Nice post" }]),
  }),
  inject: {
    channel: "response",
    path: "/api/comments",
    bad: '[{"body":"<details open ontoggle=\\"window.__cb_xss_fired=1\\"></details>"}]',
    benign: '[{"body":"Nice post"}]',
  },
  expect: {
    signal: { kind: "invariant", name: "data.xss-marker" },
    // The handler ran (xss-marker) and its `ontoggle` attribute names the
    // marker in the DOM (injected-markup).
    alsoSignals: [{ kind: "invariant", name: "data.injected-markup" }],
    // The fix shows the comment body as the text the commenter typed.
    fixedText: /ontoggle/,
  },
});
