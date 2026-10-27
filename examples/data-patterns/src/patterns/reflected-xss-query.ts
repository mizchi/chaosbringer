import { definePattern, html, page, type Variant } from "../pattern.js";

// Both pages echo the search term back above the results. The buggy page
// builds the line with innerHTML, so a term that is markup becomes markup;
// the fixed one sets it as text.
const echo: Record<Variant, string> = {
  buggy: `
    results.innerHTML = "Results for <strong>" + q + "</strong>";`,
  fixed: `
    const strong = document.createElement("strong");
    strong.textContent = q;
    results.replaceChildren("Results for ", strong);`,
};

export default definePattern({
  id: "reflected-xss-query",
  title: "A search term reflected into innerHTML",
  category: "malicious-data",
  description:
    'The search page reads q from the query string and echoes it back as "Results for <q>", built with innerHTML. A link with a crafted q reflects markup straight into the page for whoever follows it: a <details open ontoggle> payload runs its handler. Nothing is stored; the attack rides in the URL the victim clicks.',
  fix: "Put user data into the page as text (textContent, a text node, a framework's default interpolation), never into an HTML string.",
  realism: "Search boxes, filter summaries and \"no results for …\" messages that reflect a query parameter, and error pages that echo the path or a redirect target.",
  routes: (variant) => ({
    "/search": html(
      page(
        "Search",
        `<h1>Search</h1>
<p id="results">Loading…</p>
<script>
    const results = document.getElementById("results");
    const q = new URLSearchParams(location.search).get("q") ?? "";${echo[variant]}
</script>`,
      ),
    ),
  }),
  inject: {
    channel: "query",
    bad: `?q=${encodeURIComponent('<details open ontoggle="window.__cb_xss_fired=1"></details>')}`,
    benign: "?q=shoes",
  },
  crawl: { entry: "/search" },
  expect: {
    signal: { kind: "invariant", name: "data.xss-marker" },
    alsoSignals: [{ kind: "invariant", name: "data.injected-markup" }],
    // The fix echoes the term as text next to the static label.
    fixedText: /Results for/,
  },
});
