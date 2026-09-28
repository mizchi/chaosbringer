import { definePattern, html, page, type Variant } from "../pattern.js";

const EVENTS = 20_000;
const USERS = 15_000;

// An activity log of 20,000 events from ~15,000 distinct users. "Count
// visitors" collects the distinct user ids and prints how many there are.
//
// The slow page dedupes with an array: for each event it asks
// unique.includes(id), a linear scan of everything kept so far, so the whole
// pass is O(n × unique), ~150 million comparisons here, and it grows with
// the square of the log. The fixed page puts the ids in a Set (a hash
// lookup each), O(n). Same result, same order.
const dedupe: Record<Variant, string> = {
  slow: `
    function distinct(ids) {
      const unique = [];
      for (const id of ids) if (!unique.includes(id)) unique.push(id);
      return unique;
    }`,
  fixed: `
    function distinct(ids) {
      return [...new Set(ids)];
    }`,
};

export default definePattern({
  id: "quadratic-dedupe",
  title: "Deduplicating with Array.includes in a loop",
  category: "main-thread",
  description: `Clicking "Count visitors" freezes the page for a few hundred milliseconds. It dedupes ${EVENTS.toLocaleString("en-US")} user ids by pushing each into an array unless unique.includes(id) finds it: every lookup scans the whole array, so the pass is quadratic, and doubling the log quadruples the time.`,
  fix: "Use a Set (or a Map / object keyed by id) for membership: new Set(ids), or seen.has(id) in the loop; the same applies to indexOf / find / filter-inside-map lookups over a growing array.",
  routes: (variant) => ({
    "/": html(
      page(
        "Activity",
        `<h1>Activity</h1>
<button id="count" type="button">Count visitors</button>
<p id="out"></p>
<script>
    ${dedupe[variant]}
    // Deterministic ids: ${USERS.toLocaleString("en-US")} users, a quarter of them seen more than once.
    const events = Array.from({ length: ${EVENTS} }, (_, i) => "u" + ((i * 7919) % ${USERS}));
    document.getElementById("count").addEventListener("click", () => {
      document.getElementById("out").textContent = distinct(events).length + " visitors";
    });
</script>`,
      ),
    ),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 2,
    seed: 1,
    actionWeights: { scroll: 0 },
  },
  expect: {
    key: "/ :: click *",
    metric: "render.scriptMs",
    direction: "lower",
    // slow: ~310 ms (~150 M string comparisons); fixed: ~2.5 ms.
    minImprovement: { ratio: 10, absolute: 100 },
  },
});
