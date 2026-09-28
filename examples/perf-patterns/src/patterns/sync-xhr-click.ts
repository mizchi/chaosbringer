import { definePattern, handler, html, page, type Variant } from "../pattern.js";

const API_DELAY_MS = 300;

// "Check stock" asks the server whether an item is in stock; the server takes
// API_DELAY_MS to answer. The slow page asks with a synchronous
// XMLHttpRequest (open(..., false)), which parks the main thread until the
// response arrives: the click's task lasts as long as the round trip, so the
// page can neither paint "Checking…" nor answer input meanwhile. The fixed
// page asks with fetch() and renders when the promise resolves; the main
// thread is free while the request is in flight. The wait is set by the
// server's delay, not by the machine's speed.
const handlers: Record<Variant, string> = {
  slow: `
    document.getElementById("check").addEventListener("click", () => {
      const out = document.getElementById("out");
      out.textContent = "Checking…";
      const xhr = new XMLHttpRequest();
      xhr.open("GET", "/api/stock?sku=A-1042", false);
      xhr.send();
      const { inStock } = JSON.parse(xhr.responseText);
      out.textContent = inStock ? "In stock" : "Sold out";
    });`,
  fixed: `
    document.getElementById("check").addEventListener("click", async () => {
      const out = document.getElementById("out");
      out.textContent = "Checking…";
      const res = await fetch("/api/stock?sku=A-1042");
      const { inStock } = await res.json();
      out.textContent = inStock ? "In stock" : "Sold out";
    });`,
};

export default definePattern({
  id: "sync-xhr-click",
  title: "Synchronous XMLHttpRequest in a click handler",
  category: "main-thread",
  description: `Clicking "Check stock" freezes the page for the whole round trip to the server (${API_DELAY_MS} ms here). The handler uses a synchronous XMLHttpRequest, which blocks the main thread until the response arrives: no paint, no input, no timers, however slow the network is.`,
  fix: "Use an asynchronous request (fetch, or XMLHttpRequest without the false flag) and render when it resolves; show a pending state meanwhile.",
  routes: (variant) => ({
    "/": html(
      page(
        "Product",
        `<h1>Trail shoe A-1042</h1>
<button id="check" type="button">Check stock</button>
<p id="out"></p>
<script>${handlers[variant]}</script>`,
      ),
    ),
    "/api/stock": handler((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ sku: "A-1042", inStock: true }));
      }, API_DELAY_MS);
    }),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 3,
    seed: 1,
    // Only the button: every action is a click on it.
    actionWeights: { scroll: 0 },
  },
  expect: {
    key: "/ :: click *",
    metric: "cpu.blockingMs",
    direction: "lower",
    // slow: one ~300 ms task per click (the server's delay), so ~250 ms
    // blocking; fixed: the handler returns at once, 0.
    minImprovement: { ratio: 5, absolute: 150 },
  },
});
