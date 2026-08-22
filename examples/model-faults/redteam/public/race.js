/**
 * HOLE E — search-as-you-type with no request-generation guard.
 *
 * Every keystroke fires a request and every response renders. When an older,
 * slower response lands last it overwrites the newer one, so the page shows
 * results for a query the user has already replaced. Both requests succeeded,
 * nothing rejected, the state machine ends in `ready` — the failure is
 * entirely in *which* body got rendered.
 *
 * buggy  render whatever arrives.   fixed  ignore a superseded generation.
 */
const FIXED = window.__RT_FIXED__ === true;
const SESSION = window.__SESSION__;
/** The app's own bound on a search request. */
const DEADLINE_MS = 600;

const app = document.getElementById("app");
const banner = document.getElementById("banner");
const shown = document.getElementById("shown");
const input = document.getElementById("q");

let seq = 0;

function setState(state, message) {
  app.dataset.state = state;
  banner.textContent = message;
}

input.addEventListener("input", async () => {
  const q = input.value;
  const mine = ++seq;
  setState("loading", "Searching…");
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
      headers: { "x-session": SESSION },
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (FIXED && mine !== seq) return; // a superseded response is not an answer
    shown.dataset.q = data.q;
    shown.textContent = `Results for "${data.q}": ${data.results.join(", ")}`;
    setState("ready", "Results shown.");
  } catch (err) {
    setState("error", `Search failed: ${err.message}`);
  }
});
