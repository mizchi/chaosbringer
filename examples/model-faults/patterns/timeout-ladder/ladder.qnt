// Timeouts: slow is fine, forever is not.
//
// "Slow" and "never" are different failures and need different handling:
// tolerate the first, give up on the second. An app with no bound handles the
// slow case perfectly — which is why a missing bound survives review — and
// spins forever on the other.
//
// The model says nothing about milliseconds, on purpose. `slow` means "inside
// whatever bound the app sets" and `tooSlow` means "past it"; how many
// milliseconds that is depends on the machine, and the runner solves it from a
// calibration profile. The same committed plans therefore work on a laptop and
// on a slow CI runner.
module ladder {
  var opState: str // unstarted | pending | quick | slow | tooSlow
  var ui: str // idle | loading | ready | error | stuck
  var unhandled: bool
  var log: List[{ kind: str, op: str }]

  // --- the contract -----------------------------------------------------
  /// Every request is bounded, so "past the bound" resolves as an error
  /// rather than an open spinner.
  pure val BOUNDED = true

  pure def expectedUi(s: str): str =
    if (s == "quick" or s == "slow") "ready"
    else if (s == "tooSlow") (if (BOUNDED) "error" else "stuck")
    else "loading"

  action init = all {
    opState' = "unstarted",
    ui' = "idle",
    unhandled' = false,
    log' = List(),
  }

  action click = all {
    ui == "idle",
    opState' = "pending",
    ui' = "loading",
    unhandled' = false,
    log' = List({ kind: "start", op: "-" }),
  }

  action settle(terminal: str, kind: str): bool = all {
    opState == "pending",
    opState' = terminal,
    ui' = expectedUi(terminal),
    unhandled' = unhandled,
    log' = log.append({ kind: kind, op: "report" }),
  }

  action step = any {
    click,
    settle("quick", "fulfil"),
    settle("slow", "slow"),
    settle("tooSlow", "tooSlow"),
    all { ui != "idle", opState' = opState, ui' = ui, unhandled' = unhandled, log' = log },
  }

  // --- properties -------------------------------------------------------
  /// A bounded request never leaves the UI spinning.
  val neverStuck = ui != "stuck"
  /// Slowness inside the bound is not an error: an app that fails on merely
  /// slow responses is as broken as one that never gives up.
  val slowIsNotAnError = opState != "slow" or ui == "ready"
  val noUnhandled = not(unhandled)
}
