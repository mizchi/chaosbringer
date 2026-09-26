import { faults } from "chaosbringer";
import { definePattern, html, json, page, type Variant } from "../pattern.js";

// Both variants fetch /api/data on load and render it, or an error message
// once they give up. They differ only in how they retry a non-OK response.
const loaders: Record<Variant, string> = {
  // Retries at once, up to 20 times: a 503 from an overloaded backend is
  // answered with 20 more requests in a few milliseconds.
  slow: `
    async function load() {
      for (let attempt = 0; attempt <= 20; attempt++) {
        const res = await fetch("/api/data");
        if (res.ok) return res.json();
      }
      throw new Error("gave up");
    }`,
  // At most 2 retries, 100 ms then 200 ms apart.
  fixed: `
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    async function load() {
      for (let attempt = 0; attempt <= 2; attempt++) {
        if (attempt > 0) await sleep(100 * 2 ** (attempt - 1));
        const res = await fetch("/api/data");
        if (res.ok) return res.json();
      }
      throw new Error("gave up");
    }`,
};

export default definePattern({
  id: "retry-storm",
  title: "Retry storm without backoff",
  category: "chaos",
  description:
    "Invisible while the API is healthy (one request either way). When /api/data answers 503, the page retries immediately in a tight loop, multiplying load on a backend that is already failing. Only a fault makes it show.",
  fix: "Cap retries and back off exponentially (with jitter in production).",
  routes: (variant) => ({
    "/": html(
      page(
        "Dashboard",
        `<h1>Dashboard</h1>
<p id="out">Loading…</p>
<script>${loaders[variant]}
    load().then(
      (data) => { document.getElementById("out").textContent = "Items: " + data.items.length; },
      () => { document.getElementById("out").textContent = "Could not load data, try again later."; },
    );
</script>`,
      ),
    ),
    "/api/data": json({ items: [1, 2, 3] }),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 0,
    seed: 1,
    // networkidle: its 500 ms quiet window keeps the fixed variant's backed-off
    // retries (100 + 200 ms) inside the load span, so they are counted.
    settle: "networkidle",
    faults: [faults.status(503, { urlPattern: /\/api\/data/, probability: 1, name: "api-503" })],
  },
  expect: {
    key: "/ :: load",
    metric: "network.requestCount",
    direction: "lower",
    // slow: document + 21 API calls; fixed: document + 3.
    minImprovement: { ratio: 3, absolute: 10 },
  },
});
