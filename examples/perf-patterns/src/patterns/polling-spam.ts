import { definePattern, handler, html, page, type Variant } from "../pattern.js";

const SLOW_INTERVAL_MS = 50;

// Clicking "Track order" starts polling the order's status. The status
// changes about once a minute, but the slow page asks every 50 ms and keeps
// asking at that rate for as long as the page is open, visible or not.
const pollers: Record<Variant, string> = {
  slow: `
    document.getElementById("track").addEventListener("click", () => {
      setInterval(refresh, ${SLOW_INTERVAL_MS});
      refresh();
    });`,
  // Poll at a pace the data changes at: start at 2 s, back off (×2, capped at
  // 60 s) while nothing changes, pause while the tab is hidden, and never keep
  // more than one timer. (A server push, SSE or a long poll, is the other fix.)
  fixed: `
    let delay = 2000, timer = null, last = null;
    async function tick() {
      timer = null;
      if (document.hidden) return;
      const status = await refresh();
      delay = status === last ? Math.min(delay * 2, 60000) : 2000;
      last = status;
      timer = setTimeout(tick, delay);
    }
    document.addEventListener("visibilitychange", () => { if (!document.hidden && timer === null) tick(); });
    document.getElementById("track").addEventListener("click", () => {
      if (timer === null) tick();
    });`,
};

export default definePattern({
  id: "polling-spam",
  title: "Polling every 50 ms",
  category: "network",
  description: `"Track order" polls /api/order/status with setInterval every ${SLOW_INTERVAL_MS} ms: 20 requests a second, forever, for a status that changes a few times a day. Each click adds another interval. The server and the device's radio pay for every one.`,
  fix: "Poll at the pace the data changes (seconds, not milliseconds), back off while nothing changes, pause while the tab is hidden, keep one timer; or let the server push (SSE, WebSocket, long poll).",
  routes: (variant) => ({
    "/": html(
      page(
        "Order",
        `<h1>Order #1042</h1>
<button id="track" type="button">Track order</button>
<p id="status">Status: unknown</p>
<script>
    async function refresh() {
      const { status } = await (await fetch("/api/order/status")).json();
      document.getElementById("status").textContent = "Status: " + status;
      return status;
    }
    ${pollers[variant]}
</script>`,
      ),
    ),
    "/api/order/status": handler((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ status: "shipped" }));
    }),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 2,
    seed: 1,
    // Adaptive settle (100 ms quiet window): the slow page is never quiet for
    // 100 ms, so its click spans run to the 2 s action cap and count every
    // poll in them; the fixed page's single request settles in a few ms.
    actionWeights: { scroll: 0 },
  },
  expect: {
    key: "/ :: click *",
    metric: "network.requestCount",
    direction: "lower",
    // slow: ~40 polls in the first click's 2 s span, ~80 in the second (two intervals);
    // fixed: one request, then none until 2 s later (the second click adds no timer).
    minImprovement: { ratio: 5, absolute: 20 },
  },
});
