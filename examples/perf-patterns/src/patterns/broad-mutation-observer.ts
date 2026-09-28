import { definePattern, html, page, type Variant } from "../pattern.js";

const BATCH = 500;
const STATIC_ITEMS = 500;

// A tooltip helper wires up every element with a data-tip attribute,
// including ones added later, by watching the DOM with a MutationObserver on
// document.body (subtree: true). "Load more" appends 500 feed items, one
// appendChild each (500 mutation records, delivered in one callback).
//
// The slow helper treats each record as "something changed somewhere" and
// rescans the whole document for [data-tip] elements: work per record that
// is proportional to the document, O(records × DOM). The fixed helper looks
// only at what the records added (the added element and its subtree), so
// the cost is proportional to the change; it also skips text-only records.
const observers: Record<Variant, string> = {
  slow: `
    new MutationObserver((records) => {
      for (const record of records) {
        for (const el of document.querySelectorAll("[data-tip]")) bindTip(el);
      }
    }).observe(document.body, { childList: true, subtree: true });`,
  fixed: `
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches("[data-tip]")) bindTip(node);
          for (const el of node.querySelectorAll("[data-tip]")) bindTip(el);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });`,
};

export default definePattern({
  id: "broad-mutation-observer",
  title: "MutationObserver rescans the document per record",
  category: "main-thread",
  description: `Clicking "Load more" stalls for a while although it only appends ${BATCH.toLocaleString("en-US")} feed items. A tooltip helper watches all of document.body with a subtree MutationObserver and, for every mutation record, rescans the whole document with querySelectorAll; one click appends ${BATCH.toLocaleString("en-US")} nodes, so the observer does ${BATCH.toLocaleString("en-US")} full-document scans that grow with the page.`,
  fix: "Do work proportional to the change: read record.addedNodes (and filter them cheaply) instead of rescanning the document; observe the narrowest root that can change, and batch DOM insertions (a DocumentFragment is one record).",
  routes: (variant) => ({
    "/": html(
      page(
        "Feed",
        `<h1>Feed</h1>
<p><span data-tip="Your saved filters">Filters</span> · <span data-tip="Sort order">Newest first</span></p>
<button id="more" type="button">Load more</button>
<ul id="feed">${Array.from({ length: STATIC_ITEMS }, (_, i) => `<li><span data-tip="Posted by user${i % 50}">Post ${i + 1}</span></li>`).join("")}</ul>
<script>
    const bound = new WeakSet();
    function bindTip(el) {
      if (bound.has(el)) return;
      bound.add(el);
      el.title = el.dataset.tip;
    }
    for (const el of document.querySelectorAll("[data-tip]")) bindTip(el);
    ${observers[variant]}
    let next = ${STATIC_ITEMS};
    document.getElementById("more").addEventListener("click", () => {
      const feed = document.getElementById("feed");
      for (let i = 0; i < ${BATCH}; i++) {
        const li = document.createElement("li");
        li.innerHTML = '<span data-tip="Posted by user' + (next % 50) + '">Post ' + ++next + '</span>';
        feed.appendChild(li);
      }
    });
</script>`,
        `<style>body { font: 14px/1.4 system-ui, sans-serif; } #feed { list-style: none; padding: 0; }</style>`,
      ),
    ),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 3,
    seed: 1,
    actionWeights: { scroll: 0 },
  },
  expect: {
    key: "/ :: click *",
    // JS time of the click, observer callback included (it runs as a
    // microtask right after the handler, inside the span).
    metric: "render.scriptMs",
    direction: "lower",
    // slow: ~100-200 ms a click (500 scans of a 1,000-2,500-item page,
    // growing each click); fixed: ~5 ms (appending and binding 500 items).
    minImprovement: { ratio: 5, absolute: 50 },
  },
});
