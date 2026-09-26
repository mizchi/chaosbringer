import { definePattern, handler, html, page, type Route, type Variant } from "../pattern.js";

const ITEMS = 20;

const item = (id: number) => ({ id, name: `Item ${id}` });
const details = (id: number) => ({ id, price: 10 + id, stock: (id * 7) % 13 });

// Both variants render the same list with each item's price and stock. The
// slow one asks for the list, then one request per item for its details; the
// fixed one asks the list endpoint to embed the details.
const loaders: Record<Variant, string> = {
  slow: `
    async function load() {
      const items = await (await fetch("/api/items")).json();
      return Promise.all(items.map(async (it) => ({ ...it, ...(await (await fetch("/api/items/" + it.id)).json()) })));
    }`,
  fixed: `
    async function load() {
      return (await fetch("/api/items?include=details")).json();
    }`,
};

const send = (res: import("node:http").ServerResponse, body: unknown) => {
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

export default definePattern({
  id: "n-plus-one",
  title: "N+1 requests for a list",
  category: "network",
  description:
    "The list page fetches /api/items, then one /api/items/:id per row for its details: 21 API round trips for 20 rows, each with its own latency and server work.",
  fix: "Batch the details into the list request (?include=details, a batch endpoint, or GraphQL/DataLoader).",
  routes: (variant) => {
    const routes: Record<string, Route> = {
      "/": html(
        page(
          "Items",
          `<h1>Items</h1>
<ul id="list"><li>Loading…</li></ul>
<script>${loaders[variant]}
    load().then((rows) => {
      document.getElementById("list").innerHTML = rows
        .map((r) => "<li>" + r.name + ": $" + r.price + " (" + r.stock + " in stock)</li>")
        .join("");
    });
</script>`,
        ),
      ),
      "/api/items": handler((req, res) => {
        const include = new URL(req.url ?? "/", "http://x").searchParams.get("include");
        const ids = Array.from({ length: ITEMS }, (_, i) => i + 1);
        send(res, ids.map((id) => (include === "details" ? { ...item(id), ...details(id) } : item(id))));
      }),
    };
    // Same paths on both variants; the fixed page simply never calls these.
    for (let id = 1; id <= ITEMS; id++) routes[`/api/items/${id}`] = handler((_req, res) => send(res, details(id)));
    return routes;
  },
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/ :: load",
    metric: "network.requestCount",
    direction: "lower",
    // slow: document + 1 list + 20 details = 22; fixed: document + 1 = 2.
    minImprovement: { ratio: 5, absolute: 15 },
  },
});
