import { definePattern, html, json, page, type Variant } from "../pattern.js";

// Both pages draw one button per page of results. The buggy page sizes an
// array with the count as sent; the fixed one accepts only a non-negative
// integer and shows the empty state for anything else.
const show: Record<Variant, string> = {
  buggy: `
      const pages = [...Array(data.count).keys()].map((i) => i + 1);
      pager.replaceChildren(...pages.map(button));`,
  fixed: `
      const count = Number.isInteger(data.count) && data.count > 0 ? data.count : 0;
      const pages = [...Array(count).keys()].map((i) => i + 1);
      pager.replaceChildren(...(pages.length ? pages.map(button) : ["No results."]));`,
};

export default definePattern({
  id: "negative-count",
  title: "A negative count used as an array length",
  category: "bug-data",
  description:
    "The results page builds its pager from Array(data.count). When the API sends -1 for a count it couldn't compute, Array(-1) throws a RangeError inside the async loader: the pager stays on its loading text and the rejection escapes unhandled.",
  fix: "Check a count is a non-negative integer before sizing anything with it, and render the empty state otherwise.",
  realism: "APIs that send -1 for \"unknown\" or \"not counted\" (a capped or timed-out count, a cache miss), and page counts computed as ceil(total / size) - 1 that go negative on an empty result.",
  routes: (variant) => ({
    "/": html(
      page(
        "Results",
        `<h1>Results</h1>
<nav id="pager">Loading…</nav>
<script>
    const pager = document.getElementById("pager");
    const button = (n) => Object.assign(document.createElement("button"), { type: "button", textContent: String(n) });
    async function load() {
      const res = await fetch("/api/page");
      const data = await res.json();${show[variant]}
    }
    load();
</script>`,
      ),
    ),
    "/api/page": json({ count: 3 }),
  }),
  inject: {
    channel: "response",
    path: "/api/page",
    bad: '{"count":-1}',
    benign: '{"count":3}',
  },
  expect: {
    signal: { kind: "error", message: /Invalid array length/ },
    fixedText: /No results/,
  },
});
