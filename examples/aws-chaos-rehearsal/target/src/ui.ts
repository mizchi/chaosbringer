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

  function genTraceparent() {
    const buf = new Uint8Array(24);
    crypto.getRandomValues(buf);
    const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
    return "00-" + hex.slice(0, 32) + "-" + hex.slice(32, 48) + "-01";
  }

  // Record the iteration's trace+outcome to the target-side
  // trace-log so the scoring step can join chaosbringer journey
  // results with kumo's per-rule trace ring buffer (#115 phase 3).
  // Fire-and-forget — the journey's pass/fail is decided by the
  // status element, not by the trace-log POST.
  function recordTrace(traceparent, outcome) {
    fetch("/__trace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ traceparent, outcome, atMs: Date.now() }),
    }).catch(() => {});
  }

  $place.addEventListener("click", async () => {
    const traceparent = genTraceparent();
    log("traceparent=" + traceparent);
    setStatus("placed", "Placing order…");
    $place.disabled = true;
    try {
      const res = await fetch("/orders", { method: "POST", headers: { "content-type": "application/json", "traceparent": traceparent }, body: "{}" });
      if (!res.ok) {
        setStatus("error", "Place failed: HTTP " + res.status);
        log("POST /orders failed: " + res.status);
        recordTrace(traceparent, "place-failed");
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
      const verify = await fetch("/verify/" + encodeURIComponent(id), { method: "GET", headers: { "traceparent": traceparent } });
      if (verify.status === 404) {
        setStatus("missing", "Order " + id + " MISSING from store");
        log("verify: 404 — order not found");
        recordTrace(traceparent, "verify-missing");
        return;
      }
      if (!verify.ok) {
        const body = await verify.text().catch(() => "");
        setStatus("missing", "Verify failed: HTTP " + verify.status + " — " + body.slice(0, 200));
        log("verify: " + verify.status + " " + body.slice(0, 200));
        recordTrace(traceparent, "verify-failed");
        return;
      }
      setStatus("found", "Order " + id + " confirmed");
      log("verify: ok");
      recordTrace(traceparent, "found");
    } catch (err) {
      setStatus("error", "Network error: " + err);
      log("error: " + err);
      recordTrace(traceparent, "network-error");
    } finally {
      $place.disabled = false;
    }
  });
})();
</script>
</body>
</html>`;

/**
 * Per-iteration trace+outcome log (#115 phase 3). The SPA POSTs
 * each click's traceparent + outcome here so the scoring step can
 * join chaosbringer journey results with kumo's per-rule trace ring
 * buffer.
 *
 * Each entry is kept in process memory. The log is bounded to the
 * most recent N entries to avoid unbounded growth across long runs;
 * scoring reads it once at the end and the target restarts between
 * scenarios anyway.
 */
interface TraceEntry {
  traceparent: string;
  outcome: "found" | "verify-missing" | "verify-failed" | "place-failed" | "network-error" | string;
  atMs: number;
}
const TRACE_LOG_MAX = 500;
const traceLog: TraceEntry[] = [];

/**
 * Mount the SPA + /__trace observability on the given Hono app.
 * The /__trace endpoints are kept under the harness-reserved
 * `/__` prefix so they don't collide with scenario-specific
 * application routes.
 */
export function mountUI(app: Hono): void {
  app.get("/", (c) => c.html(HTML));
  app.post("/__trace", async (c) => {
    const body = (await c.req.json().catch(() => null)) as TraceEntry | null;
    if (!body || typeof body.traceparent !== "string") {
      return c.json({ error: "bad body" }, 400);
    }
    traceLog.push({
      traceparent: body.traceparent,
      outcome: body.outcome ?? "unknown",
      atMs: Number(body.atMs ?? Date.now()),
    });
    if (traceLog.length > TRACE_LOG_MAX) {
      traceLog.splice(0, traceLog.length - TRACE_LOG_MAX);
    }
    return c.json({ ok: true, n: traceLog.length });
  });
  app.get("/__trace", (c) => c.json({ entries: traceLog }));
  app.delete("/__trace", (c) => {
    traceLog.length = 0;
    return c.json({ ok: true });
  });
}
