import { definePattern, handler, html, page, type Variant } from "../pattern.js";

const QUERY = "performance patterns"; // 20 characters: 20 input events

// The crawler's input action is Playwright's fill(), which sets the value and
// dispatches a single input event: it cannot tell a debounced search box from
// one that is not. So the page has a "Type a query" button that types QUERY
// into the box one character at a time, an input event per character, in one
// burst (a fast typist, or a paste-and-edit, looks the same to the handler).
const typer = `
    document.getElementById("type").addEventListener("click", () => {
      const q = document.getElementById("q");
      q.value = "";
      for (const ch of ${JSON.stringify(QUERY)}) {
        q.value += ch;
        q.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });`;

const search = `
    async function search(term) {
      const res = await fetch("/api/search?q=" + encodeURIComponent(term));
      const { hits } = await res.json();
      document.getElementById("hits").textContent = hits.length + " results for " + term;
    }`;

const handlers: Record<Variant, string> = {
  // A request per keystroke.
  slow: `${typer}${search}
    document.getElementById("q").addEventListener("input", (e) => { search(e.target.value); });`,
  // Debounced, leading and trailing edge (lodash's { leading: true }): the
  // first keystroke of a burst searches at once, so results start showing
  // immediately, and the rest of the burst is collapsed into one request once
  // typing has paused for 150 ms. Two requests for the burst instead of 20.
  fixed: `${typer}${search}
    let timer = null, pending = null;
    document.getElementById("q").addEventListener("input", (e) => {
      const term = e.target.value;
      if (timer === null) search(term); else pending = term;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (pending !== null) { search(pending); pending = null; }
      }, 150);
    });`,
};

export default definePattern({
  id: "input-no-debounce",
  title: "Search request on every keystroke",
  category: "network",
  description:
    "Typing a 20-character query into the search box sends 20 requests to /api/search, one per keystroke, and all but the last answer are thrown away. The input handler fetches on every input event instead of waiting for the user to pause.",
  fix: "Debounce the input handler (~150–300 ms; a leading-edge call keeps the first result instant).",
  routes: (variant) => ({
    "/": html(
      page(
        "Search",
        `<h1>Search</h1>
<input id="q" type="search" placeholder="Search">
<button id="type" type="button">Type a query</button>
<p id="hits"></p>
<script>${handlers[variant]}</script>`,
      ),
    ),
    "/api/search": handler((req, res) => {
      const q = new URL(req.url ?? "/", "http://x").searchParams.get("q") ?? "";
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ hits: Array.from({ length: q.length }, (_, i) => i) }));
      }, 20);
    }),
  }),
  crawl: {
    maxPages: 1,
    maxActionsPerPage: 3,
    seed: 1,
    // Adaptive with a 400 ms quiet window. Adaptive settle does not wait for
    // timers, only for requests, long tasks and frames, and its quiet window
    // runs from the last network activity. The leading request marks that
    // activity at the click, so the trailing request (150 ms after the burst)
    // still starts inside the click's span and is counted.
    settle: 400,
    // Only the button: a fill on the box would be one input event (see above).
    actionWeights: { scroll: 0, inputs: 0 },
  },
  expect: {
    key: "/ :: click *",
    metric: "network.requestCount",
    direction: "lower",
    // slow: 20 requests a click; fixed: 2 (leading + trailing).
    minImprovement: { ratio: 5, absolute: 10 },
  },
});
