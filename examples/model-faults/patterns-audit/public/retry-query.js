/**
 * R2 (refutation attempt) — retry-idempotency: does the `$`-anchored rule
 * (`/\/api\/order$/`) let a retry escape the way it does in reconnect-budget?
 *
 * The retry appends `?attempt=1`, a standard way to make retries traceable and
 * to defeat an intermediate cache. It mints a fresh key per attempt, so if the
 * escape worked the second order would be committed unobserved.
 */
const SESSION = window.__SESSION__;
const MAX_ATTEMPTS = 2;
const BACKOFF_MS = 50;

const app = document.getElementById("app");
const banner = document.getElementById("banner");

function setState(state, message) {
  app.dataset.state = state;
  banner.textContent = message;
}

function newKey() {
  return `${SESSION}-${Math.random().toString(36).slice(2)}`;
}

async function place() {
  setState("loading", "Placing your order…");

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const url = attempt === 0 ? "/api/order" : `/api/order?attempt=${attempt}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": newKey(),
          "x-session": SESSION,
        },
        body: JSON.stringify({ item: "CB-001", qty: 1 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setState("placed", `Order ${data.id} placed.`);
      return;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS - 1) {
        setState("error", `Could not place your order: ${err.message}`);
        return;
      }
      await new Promise((r) => setTimeout(r, BACKOFF_MS));
    }
  }
}

document.getElementById("place").addEventListener("click", () => {
  void place();
});
