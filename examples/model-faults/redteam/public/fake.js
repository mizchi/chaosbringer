/**
 * HOLE C — a "load" that never loads.
 *
 * Renders a hardcoded/cached success and issues no request at all. This is
 * what a stubbed endpoint left behind a feature flag, or a cache read whose
 * revalidation was deleted in a refactor, looks like from the outside.
 *
 * Deliberately API-compatible with the sibling example's checkout page
 * (button "Load order", `#app[data-state]`, `#summary`) so it can be replayed
 * against that example's own committed happy-path plan.
 */
const CACHED = {
  cart: { items: [{ sku: "CB-001" }, { sku: "CB-014" }], total: 80 },
  shipping: { carrier: "Yamato", eta: "2026-08-24" },
};

const app = document.getElementById("app");
const banner = document.getElementById("banner");
const summary = document.getElementById("summary");

document.getElementById("load").addEventListener("click", () => {
  summary.innerHTML = "";
  const rows = [
    ["Items", String(CACHED.cart.items.length)],
    ["Total", `$${CACHED.cart.total.toFixed(2)}`],
    ["Ships via", CACHED.shipping.carrier],
    ["Arrives", CACHED.shipping.eta],
  ];
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    summary.append(dt, dd);
  }
  app.dataset.state = "ready";
  banner.textContent = "Order ready.";
});
