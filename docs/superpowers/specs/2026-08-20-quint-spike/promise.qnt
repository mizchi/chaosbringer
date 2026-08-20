// Fault-space model for one user action that fires two concurrent async ops
// combined with Promise.all, as chaosbringer would drive it in a browser.
//
// The model enumerates *fault schedules* (which op fails, how, in what
// order) and computes the *expected* UI outcome for each schedule. A trace
// therefore carries both the injection plan and its oracle.
module promise {
  // The two requests the action fires. Names match fault-rule ids.
  pure val OPS = Set("A", "B")

  // Per-op observable state.
  //   "unstarted" -> "pending" -> "fulfilled" | "rejected" | "hung"
  var opState: str -> str
  // Expected app-visible state: "idle" | "loading" | "done" | "error" | "stuck"
  var ui: str
  // Did a rejection escape every handler (window.onunhandledrejection)?
  var unhandled: bool
  // Injection plan + event log, replayed verbatim by the runner.
  var log: List[{ kind: str, op: str }]

  // --- app contract knobs -------------------------------------------------
  // Does the app attach a .catch to the Promise.all? Flipping this to false
  // makes the model produce traces whose oracle expects an unhandled
  // rejection -- i.e. the bug we are hunting.
  pure val HAS_CATCH = true
  // Does the app have a timeout / AbortController for a hung request?
  pure val HAS_TIMEOUT = false

  pure def allPending(s: str -> str): bool = OPS.forall(o => s.get(o) == "pending")
  pure def anyRejected(s: str -> str): bool = OPS.exists(o => s.get(o) == "rejected")
  pure def allFulfilled(s: str -> str): bool = OPS.forall(o => s.get(o) == "fulfilled")
  pure def anyHung(s: str -> str): bool = OPS.exists(o => s.get(o) == "hung")
  pure def settled(s: str -> str): bool =
    OPS.forall(o => s.get(o) == "fulfilled" or s.get(o) == "rejected")

  // Promise.all semantics + the app's handler contract, as an oracle.
  pure def expectedUi(s: str -> str): str =
    if (anyRejected(s)) (if (HAS_CATCH) "error" else "error")
    else if (allFulfilled(s)) "done"
    else if (anyHung(s)) (if (HAS_TIMEOUT) "error" else "stuck")
    else "loading"

  action init = all {
    opState' = OPS.mapBy(_ => "unstarted"),
    ui' = "idle",
    unhandled' = false,
    log' = List(),
  }

  // User clicks the button: both fetches go out.
  action start = all {
    ui == "idle",
    opState' = OPS.mapBy(_ => "pending"),
    ui' = "loading",
    unhandled' = false,
    log' = log.append({ kind: "start", op: "-" }),
  }

  // --- fault / success events, one op at a time (interleaving matters) ----
  action fulfil(op: str): bool = all {
    opState.get(op) == "pending",
    val nx = opState.set(op, "fulfilled")
    all {
      opState' = nx,
      ui' = expectedUi(nx),
      unhandled' = unhandled,
      log' = log.append({ kind: "fulfil", op: op }),
    },
  }

  // faults.status(500) / faults.abort() / flaky-fetch on this op.
  action reject(op: str): bool = all {
    opState.get(op) == "pending",
    val nx = opState.set(op, "rejected")
    all {
      opState' = nx,
      ui' = expectedUi(nx),
      // Promise.all rejects on the first rejection; a *second* rejection has
      // no handler attached to it -> unhandled rejection. This is the
      // Promise-spec corner the random fault injector only hits by luck.
      unhandled' = (unhandled or anyRejected(opState) or not(HAS_CATCH)),
      log' = log.append({ kind: "reject", op: op }),
    },
  }

  // A request that never settles (faults.delay(Infinity) / hung socket).
  action hang(op: str): bool = all {
    opState.get(op) == "pending",
    val nx = opState.set(op, "hung")
    all {
      opState' = nx,
      ui' = expectedUi(nx),
      unhandled' = unhandled,
      log' = log.append({ kind: "hang", op: op }),
    },
  }

  action step = any {
    start,
    nondet op = OPS.oneOf() fulfil(op),
    nondet op = OPS.oneOf() reject(op),
    nondet op = OPS.oneOf() hang(op),
    // stutter so terminal states are stable for temporal properties
    all { ui != "idle", opState' = opState, ui' = ui, unhandled' = unhandled, log' = log },
  }

  // --- properties we want witnesses (i.e. test cases) for ----------------
  val noUnhandled = not(unhandled)
  val neverStuck = ui != "stuck"
  val doubleRejectReached = not(unhandled and ui == "error")
}
