import { definePattern, html, json, page, type Variant } from "../pattern.js";

// Both pages show when the post was published, as an ISO date. The buggy page
// formats whatever `new Date()` made of the field; the fixed one checks it is
// a real date first. `new Date()` itself never throws: a string it can't parse
// gives an Invalid Date, and toISOString is what throws on one.
const show: Record<Variant, string> = {
  buggy: `
      const created = new Date(data.createdAt);
      posted.dateTime = created.toISOString();
      posted.textContent = "Published " + created.toISOString().slice(0, 10);`,
  fixed: `
      const created = new Date(data.createdAt);
      if (Number.isNaN(created.getTime())) {
        posted.textContent = "Publication date unknown";
        return;
      }
      posted.dateTime = created.toISOString();
      posted.textContent = "Published " + created.toISOString().slice(0, 10);`,
};

export default definePattern({
  id: "invalid-date-throw",
  title: "A date string that doesn't parse, formatted anyway",
  category: "bug-data",
  description:
    "The post page puts new Date(data.createdAt).toISOString() in a <time> element. When createdAt is a string Date can't parse, the Date is invalid and toISOString throws a RangeError inside the async loader: the date stays on its loading text and the rejection escapes unhandled.",
  fix: "Check the parsed date is valid (Number.isNaN(date.getTime())) before formatting it, or parse with a library that reports failure, and show a fallback.",
  realism: "Dates in a format Date can't read (15/01/2026), placeholders such as \"N/A\" or MySQL's 0000-00-00 00:00:00, an empty string for \"never\".",
  routes: (variant) => ({
    "/": html(
      page(
        "Post",
        `<h1>Post</h1>
<p><time id="posted">Loading…</time></p>
<script>
    const posted = document.getElementById("posted");
    async function load() {
      const res = await fetch("/api/post");
      const data = await res.json();${show[variant]}
    }
    load();
</script>`,
      ),
    ),
    "/api/post": json({ createdAt: "2026-01-15T09:30:00.000Z" }),
  }),
  inject: {
    channel: "response",
    path: "/api/post",
    bad: '{"createdAt":"not-a-date"}',
    benign: '{"createdAt":"2026-01-15T09:30:00.000Z"}',
  },
  expect: {
    signal: { kind: "error", message: /Invalid time value/ },
  },
});
