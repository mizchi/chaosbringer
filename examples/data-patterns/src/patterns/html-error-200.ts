import { definePattern, html, json, page, type Variant } from "../pattern.js";

// Both pages read the weekly stats. The buggy page takes a 200 as proof the
// body is JSON; the fixed one parses what came and treats anything that isn't
// JSON as a failed load. It parses rather than gating on Content-Type alone:
// good JSON also arrives under a wrong header, and the parse is what has to
// succeed.
const parse: Record<Variant, string> = {
  buggy: `
      const data = await res.json();`,
  fixed: `
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        visits.textContent = "Stats are unavailable right now.";
        return;
      }`,
};

export default definePattern({
  id: "html-error-200",
  title: "An HTML error page answered with 200",
  category: "bug-data",
  description:
    "The stats page awaits res.json() on /api/stats. When something in front of the API answers with an HTML page and a 200 (a gateway's error page, the SPA's index.html), JSON.parse meets '<' and throws a SyntaxError inside the async loader: the count stays on its loading text and the rejection escapes unhandled.",
  fix: "Don't take a 200 as proof of JSON: parse the body in a try (or check Content-Type and fall back safely) and show an error state when it isn't JSON.",
  realism: "SPA hosts whose catch-all answers unknown /api paths with index.html and 200, CDN and gateway error pages served with 200, an expired session redirected to an HTML login page that fetch follows.",
  routes: (variant) => ({
    "/": html(
      page(
        "Stats",
        `<h1>Stats</h1>
<p id="visits">Loading…</p>
<script>
    const visits = document.getElementById("visits");
    async function load() {
      const res = await fetch("/api/stats");${parse[variant]}
      visits.textContent = data.visits + " visits this week";
    }
    load();
</script>`,
      ),
    ),
    "/api/stats": json({ visits: 42 }),
  }),
  inject: {
    channel: "response",
    path: "/api/stats",
    contentType: { bad: "text/html", benign: "application/json" },
    bad: "<!doctype html><title>502</title><h1>Bad gateway</h1>",
    benign: '{"visits":42}',
  },
  expect: {
    signal: { kind: "error", message: /is not valid JSON|Unexpected token '<'/ },
  },
});
