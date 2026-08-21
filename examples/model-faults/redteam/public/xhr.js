/**
 * REFUTATION probe — the same load, over XMLHttpRequest.
 *
 * Runtime faults monkey-patch `window.fetch`, so an app on XHR (axios's
 * default transport in plenty of shipped bundles, and every analytics SDK)
 * cannot receive `reject` / `hang` / `reject-body` / `abort`. The question is
 * whether the runner notices or reports a false pass.
 */
const app = document.getElementById("app");
const banner = document.getElementById("banner");

function setState(state, message) {
  app.dataset.state = state;
  banner.textContent = message;
}

document.getElementById("load").addEventListener("click", () => {
  setState("loading", "Loading…");
  const xhr = new XMLHttpRequest();
  xhr.open("GET", "/api/feed");
  xhr.onload = () => {
    if (xhr.status >= 400) setState("error", `Could not load: HTTP ${xhr.status}`);
    else setState("ready", "Loaded.");
  };
  xhr.onerror = () => setState("error", "Could not load: network error");
  xhr.send();
});
