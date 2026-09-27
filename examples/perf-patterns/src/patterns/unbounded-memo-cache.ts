import { definePattern, html, page, type Variant } from "../pattern.js";

// Samples in one forecast: a plain array of doubles, ~4 MB on the JS heap
// (not a typed array: those live off-heap, outside jsHeapUsedMB).
const SAMPLES = 500_000;

// "Next week" moves the forecast on by a week: the view makes a new query
// object and renders it through a memoised forecast(query). The slow page
// memoises into a Map keyed by the query object. Every click makes a new
// object, so the cache never hits and never evicts: each forecast it ever
// computed stays reachable from the Map. The fixed page memoises into a
// WeakMap: an entry lives only as long as its query object, and the view
// drops the old query when it moves on, so the old forecast is collected.
const cache: Record<Variant, string> = {
  slow: `const memo = new Map();`,
  fixed: `const memo = new WeakMap();`,
};

export default definePattern({
  id: "unbounded-memo-cache",
  title: "Memo cache that never evicts",
  category: "memory",
  description: `Each "Next week" click leaves another ~4 MB forecast (${SAMPLES.toLocaleString("en-US")} samples) on the heap. The forecast is memoised in a Map keyed by the query object, and every click makes a new query object: the cache misses every time, and nothing ever removes an entry, so it holds every forecast the session has computed.`,
  fix: "Bound the cache: key it by the query's value with an LRU cap, or use a WeakMap keyed by an object whose lifetime is the view's, so entries go when their key does.",
  routes: (variant) => ({
    "/": html(
      page(
        "Forecast",
        `<h1>Demand forecast</h1>
<button id="next" type="button">Next week</button>
<p id="out"></p>
<script>
    ${cache[variant]}
    function forecast(query) {
      let samples = memo.get(query);
      if (!samples) {
        samples = [];
        for (let i = 0; i < ${SAMPLES}; i++) samples.push(Math.sin(i / 1000 + query.week) * 100 + 0.5);
        memo.set(query, samples);
      }
      return samples;
    }
    let query = { region: "EU", week: 0 };
    function render() {
      const s = forecast(query);
      let peak = -Infinity;
      for (let i = 0; i < s.length; i += 1000) if (s[i] > peak) peak = s[i];
      document.getElementById("out").textContent = "Week " + query.week + ": peak " + peak.toFixed(1);
    }
    document.getElementById("next").addEventListener("click", () => {
      query = { region: query.region, week: query.week + 1 };
      render();
    });
</script>`,
      ),
    ),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 6,
    seed: 1,
    // Only the button: every action is a click on it.
    actionWeights: { scroll: 0 },
    // Retained memory only: GC at span boundaries, so the fixed variant's
    // dropped forecast is collected before the reading.
    perf: { memory: { forceGc: true } },
  },
  expect: {
    key: "/ :: click *",
    // What each click retained, post-GC.
    metric: "memory.jsHeapDeltaMB",
    direction: "lower",
    // slow: +4.4 MB every click; fixed: 0 from the second click on (the first
    // keeps the current forecast, each later one swaps it for the next).
    minImprovement: { ratio: 4, absolute: 2 },
    alsoExpect: [
      {
        // The heap after each click (post-GC): climbs by ~4.4 MB a click on the
        // slow page (median ~17 MB over 6 clicks); ~6 MB flat on the fixed one.
        metric: "memory.jsHeapUsedMB",
        direction: "lower",
        minImprovement: { ratio: 1.5, absolute: 5 },
      },
    ],
  },
});
