/**
 * Minimal SPA mounted on the rehearsal target.
 *
 * Why a SPA on a backend service: the curl-based customer probe
 * (`POST /orders` × N → count 200s) is blind to a whole class of
 * customer-visible failures — silent data loss, duplicate writes,
 * stale reads. With a real journey, the "place order" click is
 * followed by a re-fetch of the just-written order; if it's missing,
 * the page renders "order MISSING from store" and a chaosbringer
 * journey invariant catches it.
 *
 * The SPA is deliberately threadbare: one Place Order button, a
 * verify-after-place fetch, and a status line. The point is to give
 * chaosbringer's `scenarioLoadFromStore` something real to drive.
 */
import type { Hono } from "hono";

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>OrderService — rehearsal target</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
  button { padding: 0.5rem 1rem; font-size: 1rem; cursor: pointer; }
  #status { margin-top: 1rem; padding: 0.75rem; border-radius: 4px; }
  #status[data-state="placed"]  { background: #fff3cd; }
  #status[data-state="found"]   { background: #d4edda; }
  #status[data-state="missing"] { background: #f8d7da; }
  #status[data-state="error"]   { background: #f8d7da; }
  #log { font-family: monospace; font-size: 0.85rem; white-space: pre-wrap; margin-top: 1rem; color: #555; }
</style>
</head>
<body>
<h1>OrderService</h1>
<p>Rehearsal target. Place an order and the page will verify it landed in the store.</p>

<button data-testid="place-order" id="place">Place order</button>

<div id="status" data-state="idle" data-testid="status">Idle.</div>
<div id="log" data-testid="log"></div>

<script>
(function () {
  const $status = document.getElementById("status");
  const $log = document.getElementById("log");
  const $place = document.getElementById("place");

  function setStatus(state, text) {
    $status.dataset.state = state;
    $status.textContent = text;
  }
  function log(line) {
    $log.textContent += line + "\\n";
  }

  $place.addEventListener("click", async () => {
    setStatus("placed", "Placing order…");
    $place.disabled = true;
    try {
      const res = await fetch("/orders", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!res.ok) {
        setStatus("error", "Place failed: HTTP " + res.status);
        log("POST /orders failed: " + res.status);
        return;
      }
      const { id } = await res.json();
      log("placed id=" + id);
      setStatus("placed", "Placed id=" + id + ". Verifying…");

      // Verify the write actually landed AND the variant-specific
      // session invariant still holds. /verify/:id is per-variant:
      //   - silent-loss: 200 only if the id row exists in DDB
      //   - dup-prone:   200 only if ghosts == 0 across the session
      //   - fragile:     200 only if the S3 receipt for :id exists
      // Any non-200 means the customer-visible journey failed,
      // even if POST /orders returned 200.
      const verify = await fetch("/verify/" + encodeURIComponent(id), { method: "GET" });
      if (verify.status === 404) {
        setStatus("missing", "Order " + id + " MISSING from store");
        log("verify: 404 — order not found");
        return;
      }
      if (!verify.ok) {
        const body = await verify.text().catch(() => "");
        setStatus("missing", "Verify failed: HTTP " + verify.status + " — " + body.slice(0, 200));
        log("verify: " + verify.status + " " + body.slice(0, 200));
        return;
      }
      setStatus("found", "Order " + id + " confirmed");
      log("verify: ok");
    } catch (err) {
      setStatus("error", "Network error: " + err);
      log("error: " + err);
    } finally {
      $place.disabled = false;
    }
  });
})();
</script>
</body>
</html>`;

/**
 * Mount the SPA on the given Hono app. The route handler for `GET /`
 * previously returned a "target up" text; this overrides it with the
 * journey-driving HTML. Variants that don't want the SPA simply skip
 * calling this.
 */
export function mountUI(app: Hono): void {
  app.get("/", (c) => c.html(HTML));
}
