import { definePattern, handler, html, page, type Variant } from "../pattern.js";

const ORDERS = 400;

// A full order record, the way a generic REST endpoint returns it: line items,
// addresses, a notes field, audit fields. The widget needs two of them.
function order(id: number) {
  return {
    id,
    total: Math.round((19.99 + (id % 50) * 3.1) * 100) / 100,
    status: ["paid", "shipped", "delivered"][id % 3],
    createdAt: new Date(Date.UTC(2026, 0, 1) + id * 3_600_000).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 0, 2) + id * 3_600_000).toISOString(),
    customer: {
      id: 10_000 + id,
      name: `Customer ${id}`,
      email: `customer${id}@example.com`,
      phone: `+1-555-01${String(id % 100).padStart(2, "0")}`,
    },
    shippingAddress: { line1: `${id} Harbour Street`, line2: "Apt 4", city: "Portsmouth", postcode: "PO1 2AB", country: "GB" },
    billingAddress: { line1: `${id} Harbour Street`, line2: "Apt 4", city: "Portsmouth", postcode: "PO1 2AB", country: "GB" },
    items: Array.from({ length: 8 }, (_, i) => ({
      sku: `SKU-${id}-${i}`,
      name: `Product ${i} for order ${id}`,
      description: "A sturdy, everyday product with a long description that nobody reads in a list view. ".repeat(3),
      quantity: 1 + (i % 3),
      unitPrice: 4.99 + i,
    })),
    notes: "Leave the parcel with the neighbour if nobody is home. ".repeat(4),
  };
}

const full = Buffer.from(JSON.stringify(Array.from({ length: ORDERS }, (_, i) => order(i + 1))));
const lean = Buffer.from(
  JSON.stringify(Array.from({ length: ORDERS }, (_, i) => ({ id: i + 1, total: order(i + 1).total }))),
);

// Both pages show the same "orders and revenue" summary. The slow one asks
// for the full records; the fixed one asks the endpoint for the two fields it
// shows (a sparse fieldset; GraphQL, or a dedicated summary endpoint, are the
// same idea).
const url: Record<Variant, string> = {
  slow: "/api/orders",
  fixed: "/api/orders?fields=id,total",
};

export default definePattern({
  id: "over-fetching-api",
  title: "Over-fetching an API for two fields",
  category: "network",
  description: `"Show summary" needs each order's id and total, but fetches /api/orders, which returns ${ORDERS} full order records with customers, addresses, line items and notes: about ${Math.round(full.length / 1024)} KB of JSON to download and parse for ${Math.round(lean.length / 1024)} KB of data the page uses.`,
  fix: "Ask for what the view needs: a sparse fieldset (?fields=id,total), a summary endpoint, or a GraphQL query; paginate long lists.",
  routes: (variant) => ({
    "/": html(
      page(
        "Orders",
        `<h1>Orders</h1>
<button id="summary" type="button">Show summary</button>
<p id="out"></p>
<script>
  document.getElementById("summary").addEventListener("click", async () => {
    const orders = await (await fetch(${JSON.stringify(url[variant])})).json();
    const revenue = orders.reduce((sum, o) => sum + o.total, 0);
    document.getElementById("out").textContent = orders.length + " orders, $" + revenue.toFixed(2) + " revenue";
  });
</script>`,
      ),
    ),
    "/api/orders": handler((req, res) => {
      const fields = new URL(req.url ?? "/", "http://x").searchParams.get("fields");
      const body = fields === "id,total" ? lean : full;
      res.writeHead(200, { "content-type": "application/json", "content-length": body.length, "cache-control": "no-store" });
      res.end(body);
    }),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 2,
    seed: 1,
    actionWeights: { scroll: 0 },
  },
  expect: {
    key: "/ :: click *",
    metric: "network.encodedKB",
    direction: "lower",
    // slow: ~1.4 MB of full records; fixed: ~10 KB of ids and totals.
    minImprovement: { ratio: 20, absolute: 800 },
  },
});
