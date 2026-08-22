/**
 * F4 — timeout-ladder: a bound on the banner is not a bound on the request.
 *
 * The pattern's fixed direction claims "every rung passes once the request is
 * bounded". `Promise.race([fetch(...), rejectAfter(DEADLINE_MS)])` is what a
 * large share of real code means by "bounded" — it predates AbortSignal, it is
 * what every timeout-wrapper utility on npm does, and it reads as a fix in
 * review. It bounds the *UI*: the request is never cancelled, it still reaches
 * the server, and when it finally answers, the loser of the race writes over
 * the error the user was shown.
 *
 * The oracle reads `ui` exactly once, at settleMs. `slow-trip` is solved to
 * land *after* that instant (that is what the outcome means), so the flip is
 * outside the only look the oracle takes.
 *
 * Divergence (window.__AUDIT_FIXED__):
 *   fixed  Promise.race with a 700ms deadline — passes all three rungs.
 *   buggy  no bound at all (the shipped bug) — the control, which must still
 *          be caught.
 */
const FIXED = window.__AUDIT_FIXED__ === true;
const DEADLINE_MS = 700;

const app = document.getElementById("app");
const banner = document.getElementById("banner");

function setState(state, message) {
  app.dataset.state = state;
  banner.textContent = message;
}

function deadline(ms) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
}

async function load() {
  setState("loading", "Building your report…");

  // The request. Note that nothing here can cancel it.
  const request = fetch("/api/report").then(async (res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // The loser of the race still lands, and still renders.
    setState("ready", `${data.rows} rows, generated ${data.generatedAt}`);
    return data;
  });
  request.catch(() => {
    /* the race already reported it */
  });

  try {
    if (FIXED) {
      await Promise.race([request, deadline(DEADLINE_MS)]);
    } else {
      await request;
    }
  } catch (err) {
    setState("error", `Report unavailable: ${err.message}`);
  }
}

document.getElementById("load").addEventListener("click", () => {
  void load();
});
