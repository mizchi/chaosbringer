import { definePattern, html, json, page, type Variant } from "../pattern.js";

// 12,000, not 4,000: on a CI runner the parse of a 4,000-product blob came
// to ~6 ms of script against ~2 for the fixed page, under the 5 ms the
// script-time check asks the fix to save. Three times the products is three
// times the parse; the fixed page still inlines 24.
const PRODUCTS = 12000;
const FIRST_VIEW = 24;

// A catalogue page rendered on the server and hydrated on the client. The
// server serialises the client's initial state into the HTML (a
// <script type="application/json"> blob that the client JSON.parse()s). The
// slow page's server puts the whole catalogue in it, every product with its
// description, specs and reviews (~4.5 MB), although the first view shows
// 24 cards. The fixed page's server inlines those 24 only; the rest comes
// from /api/products when the reader asks for more.
const products = Array.from({ length: PRODUCTS }, (_, i) => ({
  id: i + 1,
  name: `Product ${i + 1}`,
  price: Math.round(((i * 37) % 500) + 9.99 * 100) / 100,
  description: `Product ${i + 1} is a durable, lightweight item for everyday use; it ships in ${(i % 5) + 1} colours and comes with a two-year warranty.`,
  specs: { weightG: 100 + (i % 900), sku: `SKU-${100000 + i}`, origin: ["DE", "JP", "US", "VN"][i % 4] },
  reviews: Array.from({ length: 2 }, (_, r) => ({ stars: ((i + r) % 5) + 1, text: `Review ${r + 1}: works as described, arrived on time.` })),
}));

const initial: Record<Variant, unknown> = {
  slow: { products, total: PRODUCTS },
  fixed: { products: products.slice(0, FIRST_VIEW), total: PRODUCTS },
};

// JSON inside <script>: escape "<" so a string can never close the tag.
const inline = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

export default definePattern({
  id: "inline-state-bloat",
  title: "Whole dataset inlined in the HTML for hydration",
  category: "network",
  description: `The server inlines the client's initial state into the HTML as a JSON blob, and it puts the entire catalogue there: ${PRODUCTS.toLocaleString("en-US")} products with descriptions, specs and reviews, about 1.5 MB, for a first view of ${FIRST_VIEW} cards. Every visit downloads it before the page can finish loading, and the client parses all of it to hydrate.`,
  fix: "Serialise only the state the first view renders (the visible page of results, only the fields it shows) and fetch the rest on demand from an API, paginated.",
  routes: (variant) => ({
    "/": html(
      page(
        "Catalogue",
        `<h1>Catalogue</h1>
<ul id="grid"></ul>
<button id="more" type="button">Show more</button>
<script id="__STATE__" type="application/json">${inline(initial[variant])}</script>
<script>
    const state = JSON.parse(document.getElementById("__STATE__").textContent);
    const card = (p) => "<li><b>" + p.name + "</b> $" + p.price + "</li>";
    const grid = document.getElementById("grid");
    grid.innerHTML = state.products.slice(0, ${FIRST_VIEW}).map(card).join("");
    let shown = ${FIRST_VIEW};
    document.getElementById("more").addEventListener("click", async () => {
      if (state.products.length < shown + ${FIRST_VIEW}) {
        const res = await fetch("/api/products?offset=" + shown + "&limit=${FIRST_VIEW}");
        state.products.push(...(await res.json()).products);
      }
      grid.insertAdjacentHTML("beforeend", state.products.slice(shown, shown + ${FIRST_VIEW}).map(card).join(""));
      shown += ${FIRST_VIEW};
    });
</script>`,
      ),
    ),
    // The next page of products (the demo serves the one after the first view).
    "/api/products": json({ products: products.slice(FIRST_VIEW, FIRST_VIEW * 2) }),
  }),
  crawl: {
    maxPages: 1,
    // No clicks: the load is the step under test.
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/ :: load",
    // Every byte the load fetched: here the HTML document, uncompressed (the
    // server sends no Content-Encoding; gzip would shrink both, not the ratio much).
    metric: "page.network.totalEncodedKB",
    direction: "lower",
    minImprovement: { ratio: 10, absolute: 500 },
    // slow: ~4.5 MB of HTML; fixed: ~10 KB.
    alsoExpect: [
      {
        // JSON.parse of the blob (and the HTML parser's pass over it): ~20–35 ms
        // against ~2–3 ms.
        metric: "render.scriptMs",
        direction: "lower",
        minImprovement: { ratio: 2, absolute: 5 },
      },
    ],
  },
});
