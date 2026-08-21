/**
 * HOLE B — heartbeat with a units bug.
 *
 * `setInterval(beat, 60)` where the author meant 60 seconds. The page is
 * perfect on screen; the endpoint takes 1000x the traffic it was designed
 * for, forever, and the interval is never cleared.
 *
 * buggy  60ms.   fixed  60_000ms.
 * Both send exactly one beacon inside any plan's settle window, so the plan
 * that faults beacon #0 fires exactly once in both variants.
 */
const FIXED = window.__RT_FIXED__ === true;
const SESSION = window.__SESSION__;
const HEARTBEAT_MS = FIXED ? 60_000 : 60;

const app = document.getElementById("app");
const banner = document.getElementById("banner");
const feed = document.getElementById("feed");

function setState(state, message) {
  app.dataset.state = state;
  banner.textContent = message;
}

function beat() {
  // Fire and forget: a failed heartbeat must never break the page.
  void fetch("/api/telemetry", { method: "POST", headers: { "x-session": SESSION } }).catch(() => {});
}

async function start() {
  setState("loading", "Loading feed…");
  try {
    const res = await fetch("/api/feed", { headers: { "x-session": SESSION } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    feed.innerHTML = "";
    for (const item of data.items) {
      const li = document.createElement("li");
      li.textContent = item;
      feed.append(li);
    }
    setState("ready", "Feed loaded.");
  } catch (err) {
    setState("error", `Could not load the feed: ${err.message}`);
  }
  beat();
  setInterval(beat, HEARTBEAT_MS);
}

document.getElementById("start").addEventListener("click", () => {
  void start();
});
