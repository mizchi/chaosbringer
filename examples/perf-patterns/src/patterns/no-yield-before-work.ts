import { definePattern, html, page, type Variant } from "../pattern.js";

// Both handlers do the same, fixed amount of work: TOTAL iterations of a
// small integer hash (~200 ms on a CI core), the stand-in for recomputing a
// report after a filter changes. The work is counted in iterations, not in
// time, so a slower machine does more wall-clock work, never less.
const TOTAL = 30_000_000;

const work = `
    function recompute(filter) {
      let x = filter.length;
      for (let i = 0; i < ${TOTAL}; i++) x = (x * 31 + i) % 1000003;
      return x;
    }`;

const handlers: Record<Variant, string> = {
  // The visible response to the click (the pressed filter, the "Updating…"
  // line) is written to the DOM, but the handler goes straight on into the
  // work, so the browser cannot paint it until the work is done: the click
  // looks dead for the whole recompute.
  slow: `${work}
    document.getElementById("apply").addEventListener("click", () => {
      const btn = document.getElementById("apply");
      const out = document.getElementById("out");
      btn.classList.add("active");
      out.textContent = "Updating…";
      const x = recompute("region=EU");
      out.textContent = "Total " + x;
    });`,
  // The same work, after a yield: the handler updates the UI, then waits for
  // the next frame to be painted (a requestAnimationFrame, then a task) before
  // it starts, so the click's feedback shows at once and the work runs in a
  // task of its own. It is one task as long as before (split it too, as in
  // long-task-click, if other input must stay responsive during it).
  fixed: `${work}
    const afterNextPaint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    document.getElementById("apply").addEventListener("click", async () => {
      const btn = document.getElementById("apply");
      const out = document.getElementById("out");
      btn.classList.add("active");
      out.textContent = "Updating…";
      await afterNextPaint();
      const x = recompute("region=EU");
      out.textContent = "Total " + x;
    });`,
};

export default definePattern({
  id: "no-yield-before-work",
  title: "Click feedback waits for the work (no yield before it)",
  category: "main-thread",
  description:
    "Clicking \"Apply filter\" shows nothing for about 200 ms. The handler updates the button and the status line and then, in the same task, recomputes the report; the browser only paints between tasks, so the feedback appears together with the result, and the interaction's latency (INP) is the whole computation.",
  fix: "Update the UI first, then yield before the heavy work (await a requestAnimationFrame + setTimeout, or scheduler.yield()), so the next paint shows the feedback; move the work off the input's task.",
  routes: (variant) => ({
    "/": html(
      page(
        "Report",
        `<h1>Sales report</h1>
<button id="apply" type="button">Apply filter</button>
<p id="out"></p>
<script>${handlers[variant]}</script>`,
        `<style>button.active { background: #246; color: #fff; }</style>`,
      ),
    ),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 3,
    seed: 1,
    // Only the button: every action is a click on it. Default adaptive
    // settle: it waits out the ~200 ms task on both variants.
    actionWeights: { scroll: 0 },
  },
  expect: {
    key: "/ :: click *",
    // The click's latency, input to next paint (per-step INP). Not
    // cpu.blockingMs: both variants run the same ~200 ms task, the fix only
    // moves it after the paint. The span's interaction is read when the page
    // finishes, so it is there although the paint lands late in the span.
    metric: "interaction.maxDurationMs",
    direction: "lower",
    // Event Timing reports only events of 16 ms or more, so a fixed click
    // that painted faster has no interaction: read that as 0.
    absentAs: 0,
    // slow: ~190 ms (the whole recompute before the paint); fixed: ~16 ms (one frame).
    minImprovement: { ratio: 3, absolute: 80 },
  },
});
