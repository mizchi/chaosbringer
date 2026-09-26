import { definePattern, handler, type Variant } from "../pattern.js";

const QUERY_MS = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The page's shell (head, header, navigation, a placeholder) needs no data;
// only the orders table does, and it comes from a query that takes QUERY_MS.
const HEAD = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>Orders</title>
<style>
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; }
  header { background: #1e3a8a; color: white; padding: 16px; }
  main { padding: 16px; }
  #orders:empty::before { content: "Loading orders…"; color: #666; }
</style>
</head>
<body>
<header><strong>Acme Store</strong> · <a href="#" style="color:white">Account</a></header>
<main>
<h1>Your orders</h1>
<p>Orders from the last 90 days.</p>
`;

const orders = (n: number) =>
  `<table id="orders">${Array.from({ length: n }, (_, i) => `<tr><td>#${1000 + i}</td><td>$${(19.99 + i).toFixed(2)}</td></tr>`).join("")}</table>`;

const TAIL = `</main>
</body>
</html>`;

const render: Record<Variant, Parameters<typeof handler>[0]> = {
  // Wait for the query, then send the whole document at once: until then the
  // browser has nothing, not even the header, to paint.
  slow: async (_req, res) => {
    await sleep(QUERY_MS);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(HEAD + orders(20) + TAIL);
  },
  // Flush the shell at once and stream the rest when the query answers
  // (chunked transfer; React renderToPipeableStream, Rails/Django streaming,
  // a Suspense boundary: the same idea).
  fixed: async (_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.write(HEAD);
    await sleep(QUERY_MS);
    res.end(orders(20) + TAIL);
  },
};

export default definePattern({
  id: "no-early-flush",
  title: "HTML held back until all data is ready",
  category: "network",
  description: `The server runs the orders query (${QUERY_MS} ms) before it sends a single byte, then sends the whole document. The header, navigation and heading need none of that data, but the browser cannot paint them until the query is done, so the screen stays blank for ${QUERY_MS} ms.`,
  fix: "Flush the <head> and the page shell before the slow work (stream the HTML), and send the data-dependent part when it is ready, or render it client-side behind a skeleton.",
  routes: (variant) => ({
    "/": handler(render[variant]),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 0,
    seed: 1,
  },
  expect: {
    key: "/ :: load",
    metric: "page.vitals.FCP.value",
    direction: "lower",
    // slow: nothing to paint before the 500 ms query is done, ~540 ms; fixed: the shell paints at once, ~40 ms.
    minImprovement: { ratio: 4, absolute: 250 },
  },
});
