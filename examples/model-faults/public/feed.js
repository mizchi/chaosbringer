/**
 * Pagination order — the second page must not overtake the first.
 *
 * "Load more" twice issues two requests, and nothing about the network
 * guarantees they come back in the order they left. When page 1 is slow, page 2
 * arrives first, and an app that appends on arrival renders a feed in the wrong
 * order — with the right number of rows, the right label, and no error anywhere.
 * The user scrolls past yesterday to get to last week.
 *
 * Both requests are bounded (AbortSignal.timeout), so "slow" and "never" stay
 * different things and the bridge's appDeadlineMs is the truth. The delay that
 * makes page 1 lose the race is solved from it, not hard-coded.
 *
 * Divergence (window.__FEED_FIXED__, from the FIXED env var):
 *   fixed  responses land in a map keyed by page number and the list is
 *          rendered from that map in page order — arrival order stops
 *          mattering, which is the only fix that keeps working under three
 *          pages, retries, or a back button.
 *   buggy  each response appends on arrival.
 */
const FIXED = window.__FEED_FIXED__ === true;
const DEADLINE_MS = 1200;

const app = document.getElementById("app");
const banner = document.getElementById("banner");
const list = document.getElementById("items");

/** page number -> rows, for the fixed variant's order-independent render. */
const received = new Map();
let nextPage = 1;
let failed = 0;

function setState(state, message) {
  app.dataset.state = state;
  banner.textContent = message;
}

function row(item) {
  const li = document.createElement("li");
  li.textContent = item.title;
  // The ordering claim is checkable only if the DOM says which item it is.
  // One attribute is what makes "the rows are in order" an assertion instead
  // of an opinion — see the pattern's uiInvariants.
  li.dataset.idx = String(item.idx);
  return li;
}

function renderInOrder() {
  list.innerHTML = "";
  for (const page of [...received.keys()].sort((a, b) => a - b)) {
    for (const item of received.get(page)) list.appendChild(row(item));
  }
}

async function loadPage(page) {
  setState("loading", `Loading page ${page}…`);
  try {
    const res = await fetch(`/api/feed?page=${page}`, {
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    received.set(page, data.items);
    if (FIXED) {
      renderInOrder();
    } else {
      // Append on arrival. Correct exactly as long as the network is.
      for (const item of data.items) list.appendChild(row(item));
    }
    settle();
  } catch (err) {
    failed += 1;
    settle(err);
  }
}

/**
 * Every page that settles reports the state of the whole feed, not of itself.
 *
 * Reporting per-page is the trap: `if (failed === 0) setState("ready")` looks
 * right and leaves the banner on "Loading page 2…" forever whenever an earlier
 * page failed — a spinner that outlives every request in flight. A page that
 * failed earlier is still a failure once a later one succeeds, and a page that
 * succeeded after a failure still has to say the feed has a gap.
 */
function settle(err) {
  if (failed > 0) {
    const detail = err ? `: ${err.message}` : "";
    setState("error", `${failed} page(s) could not be loaded${detail}`);
  } else {
    setState("ready", `${list.children.length} item(s) loaded.`);
  }
}

document.getElementById("more").addEventListener("click", () => {
  void loadPage(nextPage++);
});
