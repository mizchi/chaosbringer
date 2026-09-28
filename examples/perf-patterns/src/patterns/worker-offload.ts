import { definePattern, handler, html, page, type Variant } from "../pattern.js";

// The same fixed amount of pure computation on both variants: TOTAL
// iterations of a small integer hash (~300 ms on a CI core), counted in
// iterations so a slower machine does more wall-clock work, never less. It
// touches no DOM, so it can run anywhere. The slow page runs it in the click
// handler, on the main thread. The fixed page posts it to a Web Worker
// (started with the page) and prints the answer when the worker sends it
// back: the main thread only posts a message and later sets one text node.
//
// Unlike long-task-click (which keeps the work on the main thread in yielded
// slices, so the page stays responsive but the main thread still does all of
// it), the fixed variant takes the work off the main thread entirely.
const TOTAL = 50_000_000;

const HASH = `function hashRange(x, from, to) {
  for (let i = from; i < to; i++) x = (x * 31 + i) % 1000003;
  return x;
}`;

const WORKER_JS = `${HASH}
self.onmessage = (e) => {
  self.postMessage(hashRange(0, 0, e.data.total));
};`;

const handlers: Record<Variant, string> = {
  slow: `
    ${HASH}
    document.getElementById("run").addEventListener("click", () => {
      const out = document.getElementById("out");
      out.textContent = "Working…";
      out.textContent = "Checksum " + hashRange(0, 0, ${TOTAL});
    });`,
  fixed: `
    const worker = new Worker("/js/checksum-worker.js");
    worker.onmessage = (e) => { document.getElementById("out").textContent = "Checksum " + e.data; };
    document.getElementById("run").addEventListener("click", () => {
      document.getElementById("out").textContent = "Working…";
      worker.postMessage({ total: ${TOTAL} });
    });`,
};

export default definePattern({
  id: "worker-offload",
  title: "Pure computation on the main thread instead of a worker",
  category: "main-thread",
  description:
    "Clicking \"Compute checksum\" freezes the page for about 300 ms. The handler runs a pure computation (no DOM access) on the main thread, where it blocks painting and input for its whole duration, although nothing about it needs the main thread.",
  fix: "Move DOM-free computation to a Web Worker (postMessage the input, render the result when it comes back; Comlink makes it a function call); keep the main thread for input, style, layout and paint.",
  routes: (variant) => ({
    "/": html(
      page(
        "Checksum",
        `<h1>Checksum</h1>
<button id="run" type="button">Compute checksum</button>
<p id="out"></p>
<script>${handlers[variant]}</script>`,
      ),
    ),
    // Served on both variants (same paths); only the fixed page starts it.
    "/js/checksum-worker.js": handler((_req, res) => {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      res.end(WORKER_JS);
    }),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 3,
    seed: 1,
    actionWeights: { scroll: 0 },
  },
  expect: {
    key: "/ :: click *",
    // Main-thread long tasks only: the worker's thread is not the page's
    // main thread, so its 300 ms do not count (which is the point).
    metric: "cpu.blockingMs",
    direction: "lower",
    // slow: one ~300 ms task (~250 ms blocking); fixed: a postMessage, 0.
    minImprovement: { ratio: 5, absolute: 100 },
    alsoExpect: [
      {
        // Main-thread JS time. ScriptDuration is the page's main thread
        // only, so the worker's run does not show here either.
        metric: "render.scriptMs",
        direction: "lower",
        minImprovement: { ratio: 5, absolute: 100 },
      },
    ],
  },
});
