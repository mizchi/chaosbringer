import { definePattern, html, json, page, type Variant } from "../pattern.js";

// Both pages format the post's date. The buggy page formats whatever Date the
// string parsed to; the fixed one checks the Date is valid first.
const posted: Record<Variant, string> = {
  buggy: `
      dateEl.textContent = "Posted " + created.toLocaleDateString("en-US", { dateStyle: "long", timeZone: "UTC" });`,
  fixed: `
      dateEl.textContent = Number.isNaN(created.getTime())
        ? "Posting date unknown"
        : "Posted " + created.toLocaleDateString("en-US", { dateStyle: "long", timeZone: "UTC" });`,
};

export default definePattern({
  id: "rendered-invalid-date",
  title: "An unparseable date formatted for display",
  category: "bug-data",
  description:
    'The post page shows new Date(post.createdAt) as a long date. When createdAt isn\'t a date string the browser can parse ("not-a-date"), new Date returns an Invalid Date, and toLocaleDateString formats it as the text "Invalid Date": the page reads "Posted Invalid Date". Nothing throws, so no error is reported; only the rendered text shows it.',
  fix: "Check a parsed Date is valid (Number.isNaN(date.getTime())) before formatting it, and show a fallback when it isn't.",
  realism: "Dates in a format the browser doesn't parse (a locale format, a custom timestamp), empty or placeholder strings from an import, a field renamed on the server.",
  routes: (variant) => ({
    "/": html(
      page(
        "Post",
        `<h1>Post</h1>
<p id="date">Loading…</p>
<script>
    const dateEl = document.getElementById("date");
    async function load() {
      const res = await fetch("/api/post");
      const data = await res.json();
      const created = new Date(data.createdAt);${posted[variant]}
    }
    load();
</script>`,
      ),
    ),
    "/api/post": json({ createdAt: "2026-03-14T09:30:00Z" }),
  }),
  inject: {
    channel: "response",
    path: "/api/post",
    bad: '{"createdAt":"not-a-date"}',
    benign: '{"createdAt":"2026-03-14T09:30:00Z"}',
  },
  expect: {
    signal: { kind: "invariant", name: "data.rendered-garbage" },
  },
});
