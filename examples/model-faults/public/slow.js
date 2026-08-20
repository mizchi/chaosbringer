/**
 * Timeout pattern — slow is fine, forever is not.
 *
 * A report endpoint is sometimes slow. "Slow" and "never" are different
 * things, and an app has to treat them differently: tolerate the first, give
 * up on the second. What separates them is a bound.
 *
 *   fixed  every request carries AbortSignal.timeout(DEADLINE_MS): a slow
 *          response still renders, a hung one becomes an error.
 *   buggy  no bound at all. A slow response renders too — which is exactly
 *          why this bug survives code review — and a hung one spins forever.
 *
 * DEADLINE_MS is the number every timing value in the plans is derived from:
 * the bridge feeds it to the solver, which decides how slow "slow but
 * tolerable" can be on this machine and how slow "too slow" has to be.
 */
const FIXED = window.__SLOW_FIXED__ === true;
const DEADLINE_MS = 700;

const app = document.getElementById("app");
const banner = document.getElementById("banner");

function setState(state, message) {
  app.dataset.state = state;
  banner.textContent = message;
}

async function load() {
  setState("loading", "Building your report…");
  try {
    const res = await fetch("/api/report", FIXED ? { signal: AbortSignal.timeout(DEADLINE_MS) } : {});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setState("ready", `${data.rows} rows, generated ${data.generatedAt}`);
  } catch (err) {
    setState("error", `Report unavailable: ${err.message}`);
  }
}

document.getElementById("load").addEventListener("click", () => {
  void load();
});
