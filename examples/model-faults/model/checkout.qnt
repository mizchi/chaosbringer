// Checkout data-loading contract, as a temporal model.
//
// This is a SPECIFICATION, not a prediction of the app's behaviour: every
// knob below is set to what a correct implementation must do. Enumerating it
// yields one witness trace per reachable state, and each witness replays
// against the real app as a deterministic chaosbringer run. A disagreement
// between this model and the app is therefore a bug in the app (or a bug in
// the spec — both worth a human).
//
// The app under test loads two resources in parallel for one user action:
//
//   Promise.all([ fetch("/api/cart"), fetch("/api/shipping") ])
//
// Each can fail in five ways; that is the fault space this model enumerates.
module checkout {
  // Model operation ids. These map 1:1 to fault rules in model/bridge.mjs.
  pure val OPS = Set("cart", "shipping")

  // Per-operation lifecycle.
  //   "unstarted" -> "pending" -> one of
  //     "fulfilled"    request succeeded
  //     "rejected"     request failed (network / 5xx surfaced as a rejection)
  //     "bodyRejected" response arrived, res.json() rejected (truncated body)
  //     "hung"         never settled
  //     "aborted"      cancelled via AbortController (user navigated / re-clicked)
  var opState: str -> str
  // App-visible state, as the bridge's uiProbe reports it.
  //   "idle" | "loading" | "ready" | "error" | "stuck"
  var ui: str
  // Did a rejection escape every handler (window.onunhandledrejection)?
  // The contract says: never.
  var unhandled: bool
  // The injection plan, exported verbatim in the ITF trace and compiled into
  // a FaultPlan by `chaosbringer model compile`.
  var log: List[{ kind: str, op: str }]

  // --- the contract -------------------------------------------------------
  // A correct implementation:
  //   * handles every rejection, including the second one from Promise.all
  //   * bounds every request, so a hung response becomes an error, not a
  //     spinner that never stops
    pure val HANDLES_EVERY_REJECTION = true
  pure val HAS_TIMEOUT = true

  pure def stateIs(s: str -> str, want: str): bool = OPS.exists(o => s.get(o) == want)
  pure def allAre(s: str -> str, want: str): bool = OPS.forall(o => s.get(o) == want)
  pure def failed(s: str -> str): bool = stateIs(s, "rejected") or stateIs(s, "bodyRejected")

  pure def expectedUi(s: str -> str): str =
    if (failed(s)) "error"
    else if (stateIs(s, "hung")) (if (HAS_TIMEOUT) "error" else "stuck")
    else if (allAre(s, "fulfilled")) "ready"
    else "loading"

  action init = all {
    opState' = OPS.mapBy(_ => "unstarted"),
    ui' = "idle",
    unhandled' = false,
    log' = List(),
  }

  // The user clicks "Load": both requests go out.
  action start = all {
    ui == "idle",
    allAre(opState, "unstarted"),
    opState' = OPS.mapBy(_ => "pending"),
    ui' = "loading",
    unhandled' = false,
    log' = List({ kind: "start", op: "-" }),
  }

  // One settlement event per step: the model's steps are I/O settlements,
  // not JS jobs. Microtask interleaving is out of contract (a browser gives
  // us no hook for it) — see the design doc's determinism boundary.
  action settle(op: str, terminal: str, kind: str): bool = all {
    opState.get(op) == "pending",
    val nx = opState.set(op, terminal)
    all {
      opState' = nx,
      ui' = expectedUi(nx),
      // The contract: no rejection ever escapes. Flip
      // HANDLES_EVERY_REJECTION to false to turn this model into a
      // predictor of the missing-handler bug instead of a spec of the fix.
      unhandled' = (unhandled or not(HANDLES_EVERY_REJECTION)),
      log' = log.append({ kind: kind, op: op }),
    },
  }

  action step = any {
    start,
    nondet op = OPS.oneOf() settle(op, "fulfilled", "fulfil"),
    nondet op = OPS.oneOf() settle(op, "rejected", "reject"),
    nondet op = OPS.oneOf() settle(op, "bodyRejected", "rejectBody"),
    nondet op = OPS.oneOf() settle(op, "hung", "hang"),
    // Stutter, so terminal states are stable under a temporal property.
    all { ui != "idle", opState' = opState, ui' = ui, unhandled' = unhandled, log' = log },
  }

  // --- properties ---------------------------------------------------------
  /// No rejection escapes its handlers. Every enumerated plan asserts this
  /// against the real app.
  val noUnhandled = not(unhandled)
  /// No request is left spinning: a bounded request cannot end in "stuck".
  val neverStuck = ui != "stuck"
}
