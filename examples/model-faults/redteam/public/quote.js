/**
 * HOLE A — a failed refresh leaves stale money on screen.
 *
 * The error path sets `data-state="error"` (so the model's ui label is
 * satisfied) but never clears the summary rendered from the previous quote
 * and never disables Pay. The user can therefore pay against a price the app
 * has just admitted it could not revalidate.
 *
 * buggy  error path only swaps the banner.
 * fixed  error path also clears the stale summary and disables Pay.
 */
const FIXED = window.__RT_FIXED__ === true;
const SESSION = window.__SESSION__;

const app = document.getElementById("app");
const banner = document.getElementById("banner");
const summary = document.getElementById("summary");
const pay = document.getElementById("pay");

let price = null;

function setState(state, message) {
  app.dataset.state = state;
  banner.textContent = message;
}

function render(quote) {
  summary.innerHTML = "";
  for (const [label, value] of [["Total", `$${quote.price.toFixed(2)}`], ["Quote", `rev ${quote.rev}`]]) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    summary.append(dt, dd);
  }
  price = quote.price;
  pay.disabled = false;
}

async function refresh() {
  setState("loading", "Refreshing price…");
  try {
    const res = await fetch("/api/quote", { headers: { "x-session": SESSION } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
    setState("ready", "Price is current.");
  } catch (err) {
    if (FIXED) {
      // A price we could not revalidate is not a price. Drop it.
      summary.innerHTML = "";
      price = null;
      pay.disabled = true;
    }
    setState("error", `Could not refresh the price: ${err.message}`);
  }
}

void refresh();

document.getElementById("refresh").addEventListener("click", () => {
  void refresh();
});

pay.addEventListener("click", () => {
  void fetch("/api/charge", {
    method: "POST",
    headers: { "content-type": "application/json", "x-session": SESSION },
    body: JSON.stringify({ amount: price, appState: app.dataset.state }),
  });
});
