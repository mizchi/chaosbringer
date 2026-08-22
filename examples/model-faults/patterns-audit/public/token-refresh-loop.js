/**
 * F8 — token-refresh: the refresh itself is not an operation, so no plan can
 * fail it.
 *
 * `bridge.mjs` declares two rules, `me` and `prefs`. `/api/refresh` is not
 * among them, and `token.qnt` models the refresh as one atomic action
 * (`refreshAndReplay`) that always succeeds. So the model's whole failure space
 * is "which protected requests hit 401", and the rung every real auth client
 * eventually falls off — *the refresh fails too* — has no outcome, no witness,
 * and no plan.
 *
 * That rung is where the stampede this pattern exists for actually happens: a
 * refresh that 401s and is retried is an unbounded loop against the one endpoint
 * the README calls "the endpoint you least want to overload", from a client that
 * shares its in-flight refresh perfectly.
 *
 * This page is the shipped *fixed* client — one shared in-flight refresh — plus
 * a refresh-failure branch. Both variants satisfy all four committed plans
 * identically, because no plan can reach the branch.
 *
 * Divergence (window.__AUDIT_FIXED__):
 *   fixed  a failed refresh ends the session: one attempt, then say so.
 *   buggy  a failed refresh is retried, forever.
 */
const FIXED = window.__AUDIT_FIXED__ === true;
const SESSION = window.__SESSION__;
const RETRY_MS = 30;

const app = document.getElementById("app");
const banner = document.getElementById("banner");

function setState(state, message) {
  app.dataset.state = state;
  banner.textContent = message;
}

/** Shared in-flight refresh — the pattern's own fix, kept intact. */
let inFlight = null;

function refreshToken() {
  const post = async () => {
    const res = await fetch("/api/refresh", { method: "POST", headers: { "x-session": SESSION } });
    if (!res.ok) {
      // The rung no plan can reach.
      if (FIXED) throw new Error(`refresh responded ${res.status}`);
      await new Promise((r) => setTimeout(r, RETRY_MS));
      inFlight = null;
      return refreshToken();
    }
    return res.json();
  };
  inFlight ??= post().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function withAuth(path) {
  let res = await fetch(path, { headers: { "x-session": SESSION } });
  if (res.status === 401) {
    await refreshToken();
    res = await fetch(path, { headers: { "x-session": SESSION } });
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
