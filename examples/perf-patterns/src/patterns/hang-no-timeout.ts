import { faults } from "chaosbringer";
import { definePattern, html, json, page, type Variant } from "../pattern.js";

// How long the fault holds /api/slow. Long enough to be "hung" for a user, and
// short enough that the request still ends inside the crawl, so the slow
// variant's span has a settledMs to compare (a real `hang` would leave it
// `settledUnfinished` with no number at all).
const DELAY_MS = 6000;
const TIMEOUT_MS = 1000;

const loaders: Record<Variant, string> = {
  // Waits as long as the request takes: the spinner stays up for good.
  slow: `
    async function load() {
      const res = await fetch("/api/slow");
      return res.json();
    }`,
  // Gives the request 1 s, then aborts it and shows a fallback.
  fixed: `
    async function load() {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ${TIMEOUT_MS});
      try {
        const res = await fetch("/api/slow", { signal: ctrl.signal });
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    }`,
};

export default definePattern({
  id: "hang-no-timeout",
  title: "Fetch without a timeout hangs the page",
  category: "chaos",
  description:
    "Fine while /api/slow answers quickly. When the backend stalls, the page shows its spinner for as long as the request stays open, because the fetch has no timeout and nothing else ends the wait. Only a latency or hang fault makes it show.",
  fix: "Put a deadline on the request (AbortController / AbortSignal.timeout) and show a fallback with a retry.",
  routes: (variant) => ({
    "/": html(
      page(
        "Report",
        `<h1>Report</h1>
<p id="out">Loading…</p>
<script>${loaders[variant]}
    load().then(
      (data) => { document.getElementById("out").textContent = "Rows: " + data.rows.length; },
      () => { document.getElementById("out").textContent = "The report is taking too long. Showing yesterday's numbers."; },
    );
</script>`,
      ),
    ),
    "/api/slow": json({ rows: [1, 2, 3] }),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 0,
    seed: 1,
    // Default adaptive settle: the load span waits for the request, or for the
    // fixed variant's abort.
    faults: [faults.delay(DELAY_MS, { urlPattern: /\/api\/slow/, probability: 1, name: "slow-6s" })],
    options: {
      // The fixed variant's abort is reported by Chromium as a failed request
      // (net::ERR_ABORTED). It is the fix working, not an app error.
      ignoreErrorPatterns: ["net::ERR_ABORTED"],
    },
  },
  expect: {
    key: "/ :: load",
    metric: "effectiveMs",
    direction: "lower",
    // slow: ~6 s (the delay); fixed: ~1 s (the timeout).
    minImprovement: { ratio: 3, absolute: 3000 },
  },
});
