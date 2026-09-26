import { definePattern, html, page, type Variant } from "../pattern.js";

// Both handlers do the same, fixed amount of work: TOTAL iterations of a
// small integer hash (about 300 ms on a CI core), then print the result. The
// work is counted in iterations, not in time, so a slower machine does more
// wall-clock work, never less.
const TOTAL = 50_000_000;
// The fixed variant yields to the event loop every SLICE iterations (a few ms
// each), so no single task gets near the 50 ms long-task line.
const SLICE = 1_000_000;

const work = `
    function hashRange(x, from, to) {
      for (let i = from; i < to; i++) x = (x * 31 + i) % 1000003;
      return x;
    }`;

const handlers: Record<Variant, string> = {
  // One task: the page cannot paint or answer input until it is done.
  slow: `${work}
    document.getElementById("run").addEventListener("click", () => {
      const out = document.getElementById("out");
      out.textContent = "Working…";
      const x = hashRange(0, 0, ${TOTAL});
      out.textContent = "Checksum " + x;
    });`,
  // The same work in slices, with a yield between them (scheduler.yield where
  // it exists, a zero-delay timeout elsewhere).
  fixed: `${work}
    const yieldToMain = () =>
      globalThis.scheduler && typeof scheduler.yield === "function"
        ? scheduler.yield()
        : new Promise((r) => setTimeout(r, 0));
    document.getElementById("run").addEventListener("click", async () => {
      const out = document.getElementById("out");
      out.textContent = "Working…";
      let x = 0;
      for (let from = 0; from < ${TOTAL}; from += ${SLICE}) {
        x = hashRange(x, from, Math.min(from + ${SLICE}, ${TOTAL}));
        await yieldToMain();
      }
      out.textContent = "Checksum " + x;
    });`,
};

export default definePattern({
  id: "long-task-click",
  title: "One long task in a click handler",
  category: "main-thread",
  description:
    "Clicking \"Compute checksum\" freezes the page for about 300 ms. The handler does all of its work in one synchronous task, so the browser cannot paint the \"Working…\" text or handle any other input until the whole loop has finished.",
  fix: "Split the work into slices under ~50 ms and yield between them (scheduler.yield(), or setTimeout 0).",
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
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 3,
    seed: 1,
    // Default adaptive settle: it waits out the slow variant's long task.
    actionWeights: { scroll: 0 },
  },
  expect: {
    key: "/ :: click *",
    metric: "cpu.blockingMs",
    direction: "lower",
    // slow: one ~300 ms task, so ~250 ms blocking; fixed: many ~6 ms tasks, 0.
    minImprovement: { ratio: 5, absolute: 100 },
  },
});
