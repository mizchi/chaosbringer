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
 * And the rung underneath both of those: what happens when the *refresh* fails.
 * A 401 from /api/refresh means the refresh token is expired too, and there is
 * nothing left to try — but "retry on failure" is the reflex, and a retry
 * against the endpoint that is already failing is where an auth-loop outage
 * comes from. So:
 *
 *   fixed  a failed refresh ends the session: one POST, then a state the user
 *          can act on.
 *   buggy  a failed refresh is retried, forever. From one tab that looks like
 *          patience; across a fleet it is the thing keeping the endpoint down.
 *
 * Both variants render identically in the happy cases. The difference is only
 * visible in the refresh count, which is why this pattern's model asserts on it
 * twice over: the POSTs the client issued and the ones the server served.
 */
const FIXED = window.__TOKEN_FIXED__ === true;
const SESSION = window.__SESSION__;
const RETRY_MS = 30;

const app = document.getElementById("app");
const banner = document.getElementById("banner");

function setState(state, message) {
  app.dataset.state = state;
  banner.textContent = message;
}

/**
 * A refresh that came back 401 is not an error to retry — it is the end of the
 * session. Its own class so the caller can tell it from a failed resource.
 */
class SessionExpired extends Error {}

/** Shared in-flight refresh, used by the fixed variant only. */
let inFlight = null;

async function post() {
  const res = await fetch("/api/refresh", { method: "POST", headers: { "x-session": SESSION } });
  if (res.ok) return res.json();
  // The refresh token is expired too. Nothing the client does next can help.
  if (FIXED) throw new SessionExpired(`refresh responded ${res.status}`);
  // BUG: retry the endpoint that is already failing, with no cap and no
  // growth. It may well succeed eventually — which is the trap: "it recovered"
  // and "it hammered a failing endpoint until it recovered" differ by a number
  // no screen reports.
  await new Promise((r) => setTimeout(r, RETRY_MS));
  return refreshToken();
}

function refreshToken() {
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
    if (err instanceof SessionExpired) {
      // Terminal, and the user can act on it. An expiry the app *handled* must
      // never read as an error (that is a separate rung of this contract), but
      // one it could not handle has to be said out loud rather than left as a
      // spinner.
      setState("signedOut", `Your session has expired — please sign in again.`);
    } else {
      setState("error", `Could not load your account: ${err.message}`);
    }
  }
}

document.getElementById("load").addEventListener("click", () => {
  void load();
});
