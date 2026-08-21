/**
 * F3 — pagination-order: the ordering invariant reads an attribute the app
 * derives from its own render order.
 *
 *   "The rows carry `data-idx`, which is what makes 'in order' an assertion
 *    rather than an opinion."                      (patterns/README.md)
 *
 * It makes it an assertion about `data-idx`. This page writes `data-idx` from
 * the row's position in the list instead of from the payload's `idx` — the
 * `key={i}` mistake, one of the most common in any list-rendering codebase —
 * so the attribute is a restatement of the DOM order and can never contradict
 * it. The rows themselves come from whichever response landed first.
 *
 * Divergence (window.__AUDIT_FIXED__):
 *   fixed  render from page order (the shipped fix).
 *   buggy  append on arrival (the shipped bug).
 *
 * Both variants render four rows, report `ready`, escape no rejection, and
 * satisfy the bridge's ascending/unique invariant. Only the visible text
 * differs.
 */
const FIXED = window.__AUDIT_FIXED__ === true;
const DEADLINE_MS = 1200;

const app = document.getElementById("app");
const banner = document.getElementById("banner");
const list = document.getElementById("items");

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
  // The position, not the item. Ascending and unique by construction.
  li.dataset.idx = String(list.children.length + 1);
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
      for (const item of data.items) list.appendChild(row(item));
    }
    settle();
  } catch (err) {
    failed += 1;
    settle(err);
  }
}

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
