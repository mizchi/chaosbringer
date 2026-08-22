/**
 * F5 — retry-idempotency: the state probe reads a query the page composes.
 *
 * The bridge's stateProbe asks the server
 * `/api/orders/count?session=${window.__SESSION__}` — the same scoping value
 * the page puts in its own `x-session` header. So the assertion is not "the
 * server holds one order", it is "the server holds one order *in the bucket
 * this page names*", and a write the app files under a different key is not
 * merely uncounted, it is unaskable.
 *
 * The shape: a response the client could not read is treated as "maybe our
 * session is stale", so the retry re-authenticates first. That reaction is
 * common enough to be a lint rule's worth of code in most SDKs, and the
 * idempotency key is carried correctly across both attempts — which is what
 * makes this uncomfortable: the diff against the fixed variant looks like
 * hardening, not like a bug.
 *
 * A connection that never produced a response is retried under the same
 * session, because there is no reason to think the session is at fault. That
 * keeps every `rejectBefore`-first plan honest: their expectations are met for
 * the right reason.
 *
 * Divergence (window.__AUDIT_FIXED__):
 *   fixed  one session for the whole intent — the server dedupes, one order.
 *   buggy  the retry runs under a re-minted session, so the shared key means
 *          nothing and the server commits a second order. The probe reads the
 *          first bucket and finds exactly the 1 the model predicted.
 */
const FIXED = window.__AUDIT_FIXED__ === true;
const BASE_SESSION = window.__SESSION__;
const MAX_ATTEMPTS = 2;
const BACKOFF_MS = 50;

const app = document.getElementById("app");
const banner = document.getElementById("banner");

let session = BASE_SESSION;
let reauths = 0;

function setState(state, message) {
  app.dataset.state = state;
  banner.textContent = message;
}

function newKey() {
  return `${BASE_SESSION}-${Math.random().toString(36).slice(2)}`;
}

/** "The reply was garbage — maybe our session is stale." */
function reauthenticate() {
  if (FIXED) return;
  reauths += 1;
  session = `${BASE_SESSION}-r${reauths}`;
}

async function place() {
  setState("loading", "Placing your order…");
  session = BASE_SESSION;
  reauths = 0;
  // One key per intent, carried across every attempt. The correct fix.
  const intentKey = newKey();

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch("/api/order", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": intentKey,
          "x-session": session,
        },
        body: JSON.stringify({ item: "CB-001", qty: 1 }),
      });
    } catch (err) {
      // No response at all: nothing to blame the session for.
      if (attempt === MAX_ATTEMPTS - 1) {
        setState("error", `Could not place your order: ${err.message}`);
        return;
      }
      await new Promise((r) => setTimeout(r, BACKOFF_MS));
      continue;
    }

    try {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setState("placed", `Order ${data.id} placed.`);
      return;
    } catch (err) {
      // A response we could not use. Re-authenticate, then try again.
      reauthenticate();
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
