import { definePattern, html, json, page, type Variant } from "../pattern.js";

// Three independent widgets (header, sidebar, greeting) each need the current
// user. The slow page lets every widget fetch it itself; the fixed one shares
// a single in-flight promise between them.
const getUser: Record<Variant, string> = {
  slow: `
    const getUser = () => fetch("/api/user").then((r) => r.json());`,
  fixed: `
    let userPromise;
    const getUser = () => (userPromise ??= fetch("/api/user").then((r) => r.json()));`,
};

export default definePattern({
  id: "duplicate-fetch",
  title: "Duplicate fetches of the same resource",
  category: "network",
  description:
    "Three widgets each fetch /api/user on load. The responses are identical, but the page pays for three round trips and three server hits because nothing shares or caches the request.",
  fix: "Deduplicate: share one in-flight promise (or a request cache such as SWR / React Query / a DataLoader).",
  routes: (variant) => ({
    "/": html(
      page(
        "Home",
        `<header id="header">…</header>
<aside id="sidebar">…</aside>
<main><h1 id="greeting">…</h1></main>
<script>${getUser[variant]}
    // Header widget
    getUser().then((u) => { document.getElementById("header").textContent = "Signed in as " + u.name; });
    // Sidebar widget
    getUser().then((u) => { document.getElementById("sidebar").textContent = u.plan + " plan"; });
    // Greeting widget
    getUser().then((u) => { document.getElementById("greeting").textContent = "Hello, " + u.name.split(" ")[0]; });
</script>`,
      ),
    ),
    "/api/user": json({ id: 1, name: "Ada Lovelace", plan: "Pro" }, { delayMs: 30 }),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/ :: load",
    metric: "network.requestCount",
    direction: "lower",
    // slow: document + 3 = 4; fixed: document + 1 = 2. Counts are exact, so a
    // 1.5× bound is not near the noise.
    minImprovement: { ratio: 1.5, absolute: 2 },
  },
});
