import { faults } from "chaosbringer";
import { definePattern, html, json, page, type Variant } from "../pattern.js";

const DELAY_MS = 300;

// Both variants render the same account page from three API calls, which
// need only the account id the page already has ("me"). They differ only in
// the order the calls are made.
const loaders: Record<Variant, string> = {
  // Each call waits for the previous one, as if it needed its result: a
  // request waterfall. Every call's latency adds up.
  slow: `
    async function load() {
      const user = await (await fetch("/api/user?id=me")).json();
      const orders = await (await fetch("/api/orders?user=me")).json();
      const recs = await (await fetch("/api/recommendations?user=me")).json();
      return { user, orders, recs };
    }`,
  // The three calls start together: the page waits for the slowest one only.
  fixed: `
    async function load() {
      const get = (url) => fetch(url).then((r) => r.json());
      const [user, orders, recs] = await Promise.all([
        get("/api/user?id=me"),
        get("/api/orders?user=me"),
        get("/api/recommendations?user=me"),
      ]);
      return { user, orders, recs };
    }`,
};

export default definePattern({
  id: "waterfall-amplifies-delay",
  title: "Serial API calls multiply backend latency",
  category: "chaos",
  description:
    "Hard to see while the API is fast: three quick calls in a row still load in a few ms. When every /api call takes 300 ms longer, the page waits 3 × 300 ms, because it awaits each independent call before starting the next (a request waterfall). A latency fault is what makes it show.",
  fix: "Start independent requests together (Promise.all), and only chain the ones that really need a previous result.",
  routes: (variant) => ({
    "/": html(
      page(
        "Account",
        `<h1>Account</h1>
<p id="out">Loading…</p>
<script>${loaders[variant]}
    load().then(
      ({ user, orders, recs }) => {
        document.getElementById("out").textContent =
          user.name + ": " + orders.items.length + " orders, " + recs.items.length + " recommendations";
      },
      () => { document.getElementById("out").textContent = "Could not load the account."; },
    );
</script>`,
      ),
    ),
    "/api/user": json({ id: "me", name: "Ada" }),
    "/api/orders": json({ items: [1, 2, 3] }),
    "/api/recommendations": json({ items: [4, 5] }),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 0,
    seed: 1,
    // Default adaptive settle: the load span waits for every in-flight
    // request, and the gap between two serial calls is well under its quiet
    // window, so the whole waterfall is inside the load span.
    faults: [faults.delay(DELAY_MS, { urlPattern: /\/api\//, probability: 1, name: "api-delay-300" })],
  },
  expect: {
    key: "/ :: load",
    metric: "network.settledMs",
    direction: "lower",
    // slow: ~3 × 300 ms after the document; fixed: ~300 ms.
    minImprovement: { ratio: 1.8, absolute: 400 },
  },
});
