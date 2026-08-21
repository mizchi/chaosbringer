/**
 * R1 (refutation attempt) — retry-idempotency: an uncapped retry loop that
 * carries one idempotency key per intent.
 *
 * The hypothesis was that the retry pattern, like reconnect-budget, cannot see
 * a client that keeps trying, because no plan bounds the number of POSTs
 * (`compile.sh` lifts `orders` with `--state-var` and lifts nothing with
 * `--calls-var`, unlike reconnect-budget's `--calls-var stream=attempts`).
 */
const SESSION = window.__SESSION__;
const MAX_ATTEMPTS = 6;
const BACKOFF_MS = 30;

const app = document.getElementById("app");
const banner = document.getElementById("banner");

function setState(state, message) {
  app.dataset.state = state;
  banner.textContent = message;
}

async function place() {
  setState("loading", "Placing your order…");
  const intentKey = `${SESSION}-${Math.random().toString(36).slice(2)}`;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch("/api/order", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": intentKey,
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
