/**
 * Reconnect storms — a retry loop needs a cap, and the cap is the feature.
 *
 * A dropped stream has to be retried; that part is not in question. What
 * decides whether a bad afternoon becomes an outage is what the client does
 * when the retry also fails. A loop that keeps trying is not resilience: every
 * client in the fleet is doing it at once, against the endpoint that is already
 * failing, and the reconnects are what keep it down.
 *
 * The failure is invisible from one browser. One tab reconnecting forever looks
 * like one tab being patient — which is why this needs a bound stated in the
 * model rather than a screenshot.
 *
 * Divergence (window.__STREAM_FIXED__, from the FIXED env var):
 *   fixed  at most MAX_ATTEMPTS tries, spaced by a growing backoff, then it
 *          says so and stops.
 *   buggy  no cap and no growth: 20ms apart, forever. It will connect
 *          eventually — that is the trap. "It recovers" and "it hammers a
 *          failing service until it recovers" look the same from here.
 */
const FIXED = window.__STREAM_FIXED__ === true;
const DEADLINE_MS = 500;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [60, 120];

const app = document.getElementById("app");
const banner = document.getElementById("banner");

let attempt = 0;

function setState(state, message) {
  app.dataset.state = state;
  banner.textContent = message;
}

async function connect() {
  attempt += 1;
  setState("connecting", `Connecting (attempt ${attempt})…`);
  try {
    const res = await fetch("/api/stream", { signal: AbortSignal.timeout(DEADLINE_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setState("live", `Live — ${data.events} event(s) buffered.`);
  } catch (err) {
    if (FIXED && attempt >= MAX_ATTEMPTS) {
      // Giving up is a user-visible state, not a silence. The alternative is a
      // spinner that outlives the outage.
      setState("offline", `Offline after ${attempt} attempt(s): ${err.message}`);
      return;
    }
    const wait = FIXED ? BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)] : 20;
    setTimeout(() => {
      void connect();
    }, wait);
  }
}

document.getElementById("connect").addEventListener("click", () => {
  attempt = 0;
  void connect();
});
