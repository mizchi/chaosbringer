/**
 * Checkout page: one user action loads two resources in parallel.
 *
 * Same code path for both variants — the divergences are gated on
 * `window.__CHECKOUT_FIXED__` (set by the server from the FIXED env var), the
 * same convention the dogfood playground uses. The buggy variant is the
 * default because that is the one the model-driven run is supposed to catch.
 *
 * Seeded bugs, both extremely common in real front-ends:
 *
 *   BUG-1 (unbounded load): no deadline on the requests. A response that
 *         never arrives leaves the spinner up forever instead of failing.
 *
 *   BUG-2 (eager start, sequential await): both requests are started at once
 *         to avoid a waterfall, then awaited one after the other. If the
 *         first one rejects, the function returns before anything is ever
 *         attached to the second promise — so its rejection escapes as an
 *         `unhandledrejection`. Note this is NOT what `Promise.all` does:
 *         `Promise.all` subscribes to every input immediately, so a second
 *         rejection there is handled. The bug is the sequential await.
 */
const FIXED = window.__CHECKOUT_FIXED__ === true;
const DEADLINE_MS = 1200;

const app = document.getElementById("app");
const banner = document.getElementById("banner");
const summary = document.getElementById("summary");

function setState(state, message) {
  app.dataset.state = state;
  banner.textContent = message;
}

function render(cart, shipping) {
  summary.innerHTML = "";
  const rows = [
    ["Items", String(cart.items.length)],
    ["Total", `$${cart.total.toFixed(2)}`],
    ["Ships via", shipping.carrier],
    ["Arrives", shipping.eta],
  ];
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    summary.append(dt, dd);
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return res.json();
}

/** Reject if `promise` hasn't settled within `ms`. Only used by the fixed variant. */
function withDeadline(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function load() {
  setState("loading", "Loading your order…");

  // Start both immediately: a sequential fetch here would be a waterfall.
  const cartReq = fetchJson("/api/cart");
  const shippingReq = fetchJson("/api/shipping");

  try {
    let cart;
    let shipping;
    if (FIXED) {
      // Promise.all subscribes to both promises now, so neither rejection can
      // escape, and the deadline bounds a response that never arrives.
      [cart, shipping] = await withDeadline(Promise.all([cartReq, shippingReq]), DEADLINE_MS);
    } else {
      cart = await cartReq; // BUG-2: if this rejects, shippingReq is orphaned
      shipping = await shippingReq; // BUG-1: nothing bounds either wait
    }
    render(cart, shipping);
    setState("ready", "Order ready.");
  } catch (err) {
    setState("error", `Could not load your order: ${err.message}`);
  }
}

document.getElementById("load").addEventListener("click", () => {
  void load();
});
