import { definePattern, html, page, type Variant } from "../pattern.js";

const ITEMS = 200;
const PRODUCTS = 2000;

// "Recalculate cart" walks 200 cart items. The slow page left a debug line
// in the loop that logs each item together with the whole state object (a
// 2,000-product catalogue). The fixed page keeps the line behind a debug
// flag that is off in production (a logger with levels, or a build-time
// strip of console calls, does the same).
//
// What a console.log of an object costs depends on who is listening. With a
// DevTools client attached (DevTools open, or an automation tool: Playwright
// and lightbringer both enable the CDP Runtime domain on the page), every
// call is serialised with a preview of each argument and sent to every
// session, and the inspector keeps the logged objects alive so they can be
// expanded later. That is what the crawl measures, so the number is the
// DevTools-open cost, an upper bound on what a visitor without DevTools
// pays; the fix removes it either way.
const log: Record<Variant, string> = {
  slow: `console.log("cart item", item, state);`,
  fixed: `if (DEBUG) console.log("cart item", item, state);`,
};

export default definePattern({
  id: "console-log-heavy",
  title: "console.log of large objects in a hot loop",
  category: "main-thread",
  description: `Recalculating the cart costs ~25 ms of script for a sum over ${ITEMS} items. A debug console.log left in the loop logs every item with the whole state object; with a console client attached, each call serialises previews of its arguments and the inspector retains the logged objects, so the loop spends its time in logging, not in the sum.`,
  fix: "Keep console calls out of hot paths in production: a logger with levels (debug off by default), or strip them at build time (esbuild drop: ['console'], terser drop_console); log ids or small summaries rather than whole state objects.",
  routes: (variant) => ({
    "/": html(
      page(
        "Cart",
        `<h1>Cart</h1>
<button id="go" type="button">Recalculate cart</button>
<p id="out"></p>
<script>
    const DEBUG = false;
    let round = 0;
    document.getElementById("go").addEventListener("click", () => {
      round++;
      const state = { round, products: Array.from({ length: ${PRODUCTS} }, (_, i) => ({ id: i, name: "Product " + i + " r" + round, price: i * 1.5, tags: ["a", "b"] })) };
      let total = 0;
      for (let i = 0; i < ${ITEMS}; i++) {
        const item = { id: i, qty: (i % 3) + 1, product: state.products[i] };
        ${log[variant]}
        total += item.qty * item.product.price;
      }
      document.getElementById("out").textContent = "Total " + total.toFixed(2);
    });
</script>`,
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
    // JS time of the click: building the catalogue and the loop (~1.5 ms)
    // plus, on the slow page, 200 console calls with previews.
    metric: "render.scriptMs",
    direction: "lower",
    // slow: ~30 ms a click; fixed: ~1 ms.
    minImprovement: { ratio: 4, absolute: 10 },
  },
});
