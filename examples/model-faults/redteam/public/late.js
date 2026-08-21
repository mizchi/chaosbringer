/**
 * HOLE F — an unhandled rejection that fires after the probe.
 *
 * The error path schedules a background retry and forgets to attach a
 * rejection handler to it. The escaping rejection is exactly what the
 * `unhandledRejection` oracle signal exists to catch — it just happens
 * ~900ms after the user action, and the plan run ends at the probe.
 *
 * buggy  `void retry()` inside setTimeout — nothing handles the rejection.
 * fixed  `retry().catch(report)`.
 */
const FIXED = window.__RT_FIXED__ === true;
const SESSION = window.__SESSION__;
const RETRY_DELAY_MS = 900;

const app = document.getElementById("app");
const banner = document.getElementById("banner");

function setState(state, message) {
  app.dataset.state = state;
  banner.textContent = message;
}

async function retry() {
  const res = await fetch("/api/quote-v2", { headers: { "x-session": SESSION } });
  if (!res.ok) throw new Error(`retry failed: HTTP ${res.status}`);
  return res.json();
}

async function load() {
  setState("loading", "Loading…");
  try {
    const res = await fetch("/api/quote", { headers: { "x-session": SESSION } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await res.json();
    setState("ready", "Loaded.");
  } catch (err) {
    setState("error", `Could not load: ${err.message}`);
    setTimeout(() => {
      if (FIXED) {
        void retry().catch((e) => setState("error", `Retry also failed: ${e.message}`));
      } else {
        void retry(); // BUG: no handler; a rejection here escapes
      }
    }, RETRY_DELAY_MS);
  }
}

document.getElementById("load").addEventListener("click", () => {
  void load();
});
