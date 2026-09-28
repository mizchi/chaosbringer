import { definePattern, html, page, type Variant } from "../pattern.js";

const PRODUCTS = 15_000;

// A shop keeps its state immutable, reducer style: every update returns a
// new state object. State is a 15,000-product catalogue (~5 MB as JSON) and a
// small cart. "Add to cart" changes the cart only.
//
// The slow reducer gets its "new object" by deep-cloning the whole state
// with JSON.parse(JSON.stringify(state)) and then mutating the copy: every
// click serialises and re-parses ~5 MB (and allocates a fresh copy of every
// product) to change one array. The fixed reducer shares structure: it
// copies the path to what changed (the state object and the cart) and keeps
// the untouched catalogue by reference, which is also what lets memoised
// views skip re-rendering it.
const reducers: Record<Variant, string> = {
  slow: `
    function addToCart(state, id) {
      const next = JSON.parse(JSON.stringify(state));
      next.cart.items.push({ id, qty: 1 });
      next.cart.count += 1;
      return next;
    }`,
  fixed: `
    function addToCart(state, id) {
      return {
        ...state,
        cart: { items: [...state.cart.items, { id, qty: 1 }], count: state.cart.count + 1 },
      };
    }`,
};

export default definePattern({
  id: "json-deep-clone-per-click",
  title: "Deep-cloning the whole state on every update",
  category: "main-thread",
  description: `Clicking "Add to cart" takes some 50 ms of script although it changes a two-field cart. The reducer copies the entire state with JSON.parse(JSON.stringify(state)) (a ${PRODUCTS.toLocaleString("en-US")}-product catalogue, ~5 MB) before changing the cart, so each click serialises, re-parses and re-allocates everything, and the cost grows with the state rather than with the change.`,
  fix: "Update immutably with structural sharing: copy only the objects on the path to the change ({ ...state, cart: { ...state.cart, items: [...items, item] } }) and keep the rest by reference; Immer's produce() does this for you. Reserve deep clones (structuredClone) for when a full copy is really needed.",
  routes: (variant) => ({
    "/": html(
      page(
        "Shop",
        `<h1>Shop</h1>
<button id="add" type="button">Add to cart</button>
<p id="cart">Cart: 0 items</p>
<script>
    ${reducers[variant]}
    let state = {
      catalogue: Array.from({ length: ${PRODUCTS} }, (_, i) => ({
        id: "sku-" + i,
        name: "Product " + i + " — stainless steel water bottle, 750 ml",
        description: "Double-walled, keeps drinks cold for 24 hours and hot for 12. Dishwasher safe lid. Item " + i + ".",
        price: ((i * 7919) % 10000) / 100,
        tags: ["outdoor", "kitchen", "gift", "sale-" + (i % 7)],
        stock: { warehouse: i % 50, store: i % 9, reserved: i % 3 },
        rating: { average: (i % 50) / 10, count: i % 400 },
      })),
      cart: { items: [], count: 0 },
    };
    document.getElementById("add").addEventListener("click", () => {
      state = addToCart(state, "sku-" + (state.cart.count % ${PRODUCTS}));
      document.getElementById("cart").textContent = "Cart: " + state.cart.count + " items";
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
    metric: "render.scriptMs",
    direction: "lower",
    // slow: ~45 ms a click (stringify + parse of ~5 MB; ~145 ms on the first,
    // before the JIT warms up); fixed: ~1 ms.
    minImprovement: { ratio: 5, absolute: 20 },
  },
});
