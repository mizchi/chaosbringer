/**
 * Stale-while-revalidate — serving the cached copy is allowed; keeping it is not.
 *
 * The read-side twin of optimistic UI. Showing a cached copy instantly is the
 * whole point of the pattern, so "the screen shows old data" cannot be the bug
 * on its own — what makes it a bug is *ending* there. The app owes the user
 * either the newer copy or an honest label, and the failure is the one that
 * looks best on a flame graph: the request goes out, the response comes back,
 * and nothing consumes it.
 *
 * Divergence (window.__CACHE_FIXED__, from the FIXED env var):
 *   fixed  the revalidation's body replaces what is on screen; a failed
 *          revalidation leaves the cached copy up and says so.
 *   buggy  the success path drops the body — the classic "stop the spinner but
 *          forget to set the data" — and flips the banner to fresh anyway. The
 *          error path is correct, which is why the bug survives: every failure
 *          case a reviewer thinks to try behaves perfectly.
 */
const FIXED = window.__CACHE_FIXED__ === true;

const app = document.getElementById("app");
const banner = document.getElementById("banner");
const profile = document.getElementById("profile");

/** The newest revision the app has received, whatever it chose to render. */
let received = 0;

function setState(state, message) {
  app.dataset.state = state;
  banner.textContent = message;
}

function render(data) {
  profile.dataset.rev = String(data.rev);
  profile.textContent = `${data.name} (rev ${data.rev})`;
}

async function read() {
  const res = await fetch("/api/profile", { headers: { "x-session": window.__SESSION__ } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  received = data.rev;
  return data;
}

/** Page load: nothing cached yet, so there is nothing to serve stale. */
async function load() {
  try {
    render(await read());
    setState("fresh", "Up to date.");
  } catch (err) {
    setState("error", `Could not load the profile: ${err.message}`);
  }
}

async function refresh() {
  // Serve the cached copy first. This is the feature, not the bug.
  setState("stale", "Showing the cached copy while we check for updates…");
  try {
    const data = await read();
    if (FIXED) {
      render(data);
      setState("fresh", "Up to date.");
    } else {
      // The response was read, parsed, and thrown away. `received` moved; the
      // screen did not.
      setState("fresh", "Up to date.");
    }
  } catch (err) {
    // Correct in both variants: a revalidation that failed leaves the cached
    // copy on screen and says which one the user is looking at.
    setState("stale", `Showing the cached copy — could not check for updates: ${err.message}`);
  }
}

document.getElementById("refresh").addEventListener("click", () => {
  void refresh();
});

void load();
