import { definePattern, handler, html, page, type Variant } from "../pattern.js";

const SECTIONS = 60;
// Scroll positions the "Read the article" button replays, one scroll event each.
const STEPS = 120;
// The fixed page sends its queue when this many events are waiting.
const BATCH = 50;

const article = Array.from(
  { length: SECTIONS },
  (_, i) => `<section><h2>Part ${i + 1}</h2><p>Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.</p></section>`,
).join("\n");

// As in unthrottled-scroll, the crawler's own scroll action is one
// window.scrollTo (one scroll event), so a button replays a reader's scroll:
// STEPS positions in one task, a scroll event after each.
const reader = `
    document.getElementById("read").addEventListener("click", () => {
      const max = document.documentElement.scrollHeight - innerHeight;
      for (let i = 1; i <= ${STEPS}; i++) {
        window.scrollTo(0, Math.round((max * i) / ${STEPS}));
        window.dispatchEvent(new Event("scroll"));
      }
    });`;

// Both pages record the same event for every scroll (the scroll depth, for
// a "how far do readers get" report) and deliver all of them to the same
// collector. The slow page sends each event as its own POST, the moment it
// happens: one request per scroll event. The fixed page queues events and
// sends them BATCH at a time in one navigator.sendBeacon() (which the
// browser delivers even if the page is closing), and flushes what is left
// when the page is hidden, the last moment a page is reliably told about.
const trackers: Record<Variant, string> = {
  slow: `
    function track(event) {
      fetch("/api/collect", { method: "POST", keepalive: true, headers: { "content-type": "application/json" }, body: JSON.stringify(event) });
    }`,
  fixed: `
    const queue = [];
    function flush() {
      if (queue.length === 0) return;
      navigator.sendBeacon("/api/collect", JSON.stringify(queue.splice(0)));
    }
    function track(event) {
      queue.push(event);
      if (queue.length >= ${BATCH}) flush();
    }
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });`,
};

export default definePattern({
  id: "analytics-per-event",
  title: "One analytics request per scroll event",
  category: "network",
  description: `Scrolling the article sends a request for every scroll event: the scroll-depth tracker POSTs each event to /api/collect as it happens, so one flick of the page (${STEPS} scroll events) is ${STEPS} requests, queued six at a time behind the page's own traffic and each paying its own headers and round trip.`,
  fix: "Queue analytics events and send them in batches (by count or on a timer), with navigator.sendBeacon (or fetch keepalive) and a final flush on visibilitychange → hidden; throttle high-frequency sources (scroll depth changes in steps, not per event).",
  routes: (variant) => ({
    "/": html(
      page(
        "Article",
        `<h1>Long read</h1>
<button id="read" type="button">Read the article</button>
<main>${article}</main>
<script>
    ${trackers[variant]}
    window.addEventListener("scroll", () => {
      track({ type: "scroll", depth: Math.round((scrollY / (document.documentElement.scrollHeight - innerHeight)) * 100), t: Date.now() });
    }, { passive: true });
    ${reader}
</script>`,
        `<style>body { font: 16px/1.5 system-ui, sans-serif; margin: 0 16px; } section { min-height: 300px; }</style>`,
      ),
    ),
    "/api/collect": handler((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(204, { "cache-control": "no-store" });
        res.end();
      });
    }),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 2,
    seed: 1,
    // Only the button (the crawler's own scroll is one event; see above).
    actionWeights: { scroll: 0 },
  },
  expect: {
    key: "/ :: click *",
    metric: "network.requestCount",
    direction: "lower",
    // slow: 121 POSTs (the 120 dispatched events, plus the one real scroll
    // event the browser fires for the scrollTo calls at the next frame);
    // fixed: 2 beacons of 50 (the last 21 events wait for the page to hide).
    minImprovement: { ratio: 10, absolute: 60 },
  },
});
