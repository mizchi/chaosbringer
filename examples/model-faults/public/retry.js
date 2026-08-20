/**
 * Retry pattern — one user intent, one order.
 *
 * The interesting failure is not "the request failed". It is "the request
 * succeeded and the client could not tell": the server committed the write,
 * the response never made it back, and the client retries. Whether that
 * produces one order or two is decided entirely by whether the retry carries
 * an idempotency key.
 *
 * Divergence (window.__ORDER_FIXED__, from the FIXED env var):
 *   fixed  every attempt of the same intent carries one Idempotency-Key, so
 *          the server dedupes a repeated write.
 *   buggy  the key is minted per attempt, which is the same as having none:
 *          the retry looks like a brand-new order. This is the shape that
 *          double-charges customers, and it looks perfectly healthy on screen.
 */
const FIXED = window.__ORDER_FIXED__ === true;
const SESSION = window.__SESSION__;
const MAX_ATTEMPTS = 2;
const BACKOFF_MS = 50;

const app = document.getElementById("app");
const banner = document.getElementById("banner");

function setState(state, message) {
  app.dataset.state = state;
  banner.textContent = message;
}

// One key per user intent, minted before the first attempt — that is the whole
// point. Minting it inside the loop (the buggy variant) defeats it.
function newKey() {
  return `${SESSION}-${Math.random().toString(36).slice(2)}`;
}

async function place() {
  setState("loading", "Placing your order…");
  const intentKey = newKey();

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch("/api/order", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": FIXED ? intentKey : newKey(),
          "x-session": SESSION,
        },
        body: JSON.stringify({ item: "CB-001", qty: 1 }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Reading the body can fail after the server has already committed —
      // which is exactly the case that makes the retry dangerous.
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
