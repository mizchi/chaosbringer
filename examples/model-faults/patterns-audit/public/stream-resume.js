/**
 * F2 — reconnect-budget: the operation identity is a regex, and the regex is
 * anchored.
 *
 * The bridge names the operation `stream: { urlPattern: /\/api\/stream$/ }`.
 * `$` makes that a URL-*string* identity, not an endpoint identity — and every
 * resumable stream in production carries a parameter: a cursor, a
 * `Last-Event-ID`, an attempt number, a `?_=Date.now()` cache-buster.
 *
 * This page connects exactly once on the bare URL (so the plan's injection and
 * its `expect.calls` bound both see what they expect) and then resumes from the
 * cursor the server handed back. The resume loop is the reconnect loop: same
 * endpoint, same failing service, same fleet-wide amplification — and it is
 * invisible to the count that is this pattern's entire contract.
 *
 * Divergence (window.__AUDIT_FIXED__):
 *   fixed  one resume, then stop.
 *   buggy  resume every RESUME_MS, forever, with no cap and no backoff.
 */
const FIXED = window.__AUDIT_FIXED__ === true;
const DEADLINE_MS = 500;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [60, 120];
const RESUME_MS = 25;

const app = document.getElementById("app");
const banner = document.getElementById("banner");

let attempt = 0;
let resumes = 0;

function setState(state, message) {
  app.dataset.state = state;
  banner.textContent = message;
}

/** The resume loop. One extra query parameter and nothing counts it. */
function scheduleResume(cursor) {
  if (!FIXED || resumes < 1) {
    setTimeout(() => {
      void resume(cursor);
    }, RESUME_MS);
  }
}

async function resume(cursor) {
  resumes += 1;
  try {
    const res = await fetch(`/api/stream?cursor=${encodeURIComponent(cursor)}`, {
      signal: AbortSignal.timeout(DEADLINE_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setState("live", `Live — ${data.events} event(s) buffered.`);
    scheduleResume(data.cursor ?? cursor);
  } catch {
    // A resume that fails is just another reconnect, and this loop has no cap.
    scheduleResume(cursor);
  }
}

async function connect() {
  attempt += 1;
  setState("connecting", `Connecting (attempt ${attempt})…`);
  try {
    const res = await fetch("/api/stream", { signal: AbortSignal.timeout(DEADLINE_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setState("live", `Live — ${data.events} event(s) buffered.`);
    scheduleResume(data.cursor ?? "c-1");
  } catch (err) {
    if (attempt >= MAX_ATTEMPTS) {
      setState("offline", `Offline after ${attempt} attempt(s): ${err.message}`);
      return;
    }
    const wait = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
    setTimeout(() => {
      void connect();
    }, wait);
  }
}

document.getElementById("connect").addEventListener("click", () => {
  attempt = 0;
  resumes = 0;
  void connect();
});
