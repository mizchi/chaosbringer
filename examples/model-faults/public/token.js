/**
 * Token refresh — one expired token, one refresh.
 *
 * The page loads two resources for one user action. When a token has expired
 * both come back 401 at the same moment, and each one wants to refresh. What
 * happens next is the pattern:
 *
 *   fixed  the refresh is a single shared in-flight promise, so the second
 *          401 joins the refresh already running: one POST /api/refresh.
 *   buggy  each 401 starts its own refresh. Two here, N under real load —
 *          a stampede against the one endpoint you least want to overload,
 *          and on a rotating-refresh-token backend the second one invalidates
 *          the first, logging the user out.
 *
 * Both variants render identically. The difference is only visible in the
 * refresh count, which is why this pattern's model asserts on it.
 */
const FIXED = window.__TOKEN_FIXED__ === true;
const SESSION = window.__SESSION__;

const app = document.getElementById("app");
const banner = document.getElementById("banner");

function setState(state, message) {
  app.dataset.state = state;
  banner.textContent = message;
}

/** Shared in-flight refresh, used by the fixed variant only. */
let inFlight = null;

function refreshToken() {
  const post = () =>
    fetch("/api/refresh", { method: "POST", headers: { "x-session": SESSION } });
  if (!FIXED) return post(); // BUG: every 401 starts its own refresh
  inFlight ??= post().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function withAuth(path) {
  let res = await fetch(path, { headers: { "x-session": SESSION } });
  if (res.status === 401) {
    await refreshToken();
    res = await fetch(path, { headers: { "x-session": SESSION } }); // replay
  }
  if (!res.ok) throw new Error(`${path} responded ${res.status}`);
  return res.json();
}

async function load() {
  setState("loading", "Loading your account…");
  try {
    const [me, prefs] = await Promise.all([withAuth("/api/me"), withAuth("/api/prefs")]);
    setState("ready", `${me.name} — ${prefs.theme} theme`);
  } catch (err) {
    setState("error", `Could not load your account: ${err.message}`);
  }
}

document.getElementById("load").addEventListener("click", () => {
  void load();
});
