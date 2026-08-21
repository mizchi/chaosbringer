/**
 * HOLE D — the retry-idempotency bug against a queue-backed backend.
 *
 * Identical app bug to the sibling example's retry pattern (a fresh
 * idempotency key per attempt, so the retry of a write the server already
 * accepted becomes a second order). The only difference is the backend:
 * `POST /api/rt/order` acknowledges immediately and commits later, the way
 * every 202-Accepted API does. The duplicate therefore commits after the
 * probe has already read the order count.
 *
 * buggy  key minted per attempt.   fixed  one key per intent.
 */
const FIXED = window.__RT_FIXED__ === true;
const SESSION = window.__SESSION__;
const MAX_ATTEMPTS = 2;
const BACKOFF_MS = 500;

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
  const intentKey = newKey();

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch("/api/rt/order", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": FIXED ? intentKey : newKey(),
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
