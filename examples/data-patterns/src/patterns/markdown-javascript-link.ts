import { definePattern, html, json, page, type Variant } from "../pattern.js";

// Both pages render a post written in a small Markdown subset: the text is
// HTML-escaped first, then [text](url) becomes a link. Escaping keeps the
// author's markup out but not their URL scheme. The buggy renderer links any
// URL; the fixed one links only web and mail addresses and leaves the rest as
// plain text.
const render: Record<Variant, string> = {
  buggy: `
    function renderMarkdown(md) {
      return escapeHtml(md).replace(LINK, (_, text, href) => '<a href="' + href + '">' + text + "</a>");
    }`,
  fixed: `
    const SAFE_PROTOCOLS = ["http:", "https:", "mailto:"];
    function renderMarkdown(md) {
      return escapeHtml(md).replace(LINK, (_, text, href) => {
        const safe = URL.canParse(href, location.href) && SAFE_PROTOCOLS.includes(new URL(href, location.href).protocol);
        return safe ? '<a href="' + href + '">' + text + "</a>" : text;
      });
    }`,
};

export default definePattern({
  id: "markdown-javascript-link",
  title: "A Markdown renderer that links any URL scheme",
  category: "malicious-data",
  description:
    "The blog renders posts and comments with a hand-rolled Markdown renderer. It escapes HTML, so <script> in a post stays text, and then turns [text](url) into <a href=\"url\">. A post containing [site](javascript:…) becomes a link that runs the author's script for every reader who clicks it.",
  fix: "Resolve each link's URL and keep it only when the protocol is on an allowlist (http:, https:, mailto:); render anything else as text. Libraries do this with a sanitizer pass (DOMPurify, or the renderer's own safe-URL check).",
  realism:
    "Comments, READMEs, chat messages and CMS fields rendered from Markdown on the client, by a home-grown regex or a library with sanitizing turned off.",
  routes: (variant) => ({
    "/": html(
      page(
        "Post",
        `<h1>Release notes</h1>
<article id="post">Loading…</article>
<script>
    // [text](url)
    const LINK = /\\[([^\\]]*)\\]\\(([^)\\s]+)\\)/g;
    function escapeHtml(s) {
      return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }${render[variant]}
    async function load() {
      const res = await fetch("/api/post");
      const post = await res.json();
      document.getElementById("post").innerHTML = renderMarkdown(post.md);
    }
    load();
</script>`,
      ),
    ),
    "/api/post": json({ md: "See [site](https://example.org/)" }),
  }),
  inject: {
    channel: "response",
    path: "/api/post",
    bad: '{"md":"See [site](javascript:window.__cb_xss_fired=1)"}',
    benign: '{"md":"See [site](https://example.org/)"}',
  },
  // As in javascript-url-sink: nothing clicks the link, the check is on the sink.
  crawl: { maxActionsPerPage: 0 },
  expect: {
    signal: { kind: "invariant", name: "data.injected-markup" },
    // The unsafe link is rendered as its plain text, "See site".
    fixedText: /See site/,
  },
});
