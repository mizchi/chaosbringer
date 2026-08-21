// Reconnect budget: a retry loop needs a cap, and the cap is the feature.
//
// Retrying a dropped stream is not in question. What decides whether a bad
// afternoon becomes an outage is what the client does when the retry also
// fails — because every client in the fleet is doing the same thing at once,
// against the service that is already failing, and the reconnects are what keep
// it down.
//
// This is the pattern where the *number of requests* is the contract. No state
// on screen distinguishes a client with a budget from one without: both show a
// spinner and then, eventually, a connection. So the model counts attempts and
// states the total, which `--calls-var` lifts into `expect.calls` — the only
// expectation that can say "and no more than that".
//
// A note on what the plans can and cannot say. A schedule describes the
// occurrences it enumerated and lets later ones pass, so a client with no cap
// eventually connects on the attempt past the end of the schedule. That is the
// trap this pattern exists for: "it recovers" and "it hammers a failing service
// until it recovers" look identical on screen, and differ by one number.
module reconnect {
  // Connection attempts issued. The contract, and the only observable that
  // separates the two implementations.
  var attempts: int
  // Per-attempt outcome, so the enumeration covers the ladder rather than just
  // the terminal states — "connected" is reachable from every rung.
  var a1: str // none | fulfil | reject
  var a2: str
  var a3: str
  var ui: str // idle | connecting | live | offline
  var unhandled: bool
  var log: List[{ kind: str, op: str }]

  // --- the contract -----------------------------------------------------
  /// Three tries, then say so. The number is arbitrary; having one is not.
  pure val MAX_ATTEMPTS = 3
  pure val HANDLES_EVERY_REJECTION = true

  pure def budgetSpent(n: int): bool = n >= MAX_ATTEMPTS

  action init = all {
    attempts' = 0,
    a1' = "none",
    a2' = "none",
    a3' = "none",
    ui' = "idle",
    unhandled' = false,
    log' = List(),
  }

  /// The user connects. One intent; every later attempt is the client's own.
  action click = all {
    attempts == 0,
    attempts' = 1,
    a1' = "none",
    a2' = "none",
    a3' = "none",
    ui' = "connecting",
    unhandled' = unhandled,
    log' = List(),
  }

  /// An attempt that connects. Nothing further is owed.
  action fulfil = all {
    attempts > 0,
    ui == "connecting",
    attempts' = attempts,
    a1' = if (attempts == 1) "fulfil" else a1,
    a2' = if (attempts == 2) "fulfil" else a2,
    a3' = if (attempts == 3) "fulfil" else a3,
    ui' = "live",
    unhandled' = unhandled,
    log' = log.append({ kind: "fulfil", op: "stream" }),
  }

  /// An attempt that fails. Inside the budget it costs another attempt; at the
  /// end of it the app owes the user a terminal state instead.
  action reject = all {
    attempts > 0,
    ui == "connecting",
    attempts' = if (budgetSpent(attempts)) attempts else attempts + 1,
    a1' = if (attempts == 1) "reject" else a1,
    a2' = if (attempts == 2) "reject" else a2,
    a3' = if (attempts == 3) "reject" else a3,
    ui' = if (budgetSpent(attempts)) "offline" else "connecting",
    unhandled' = (unhandled or not(HANDLES_EVERY_REJECTION)),
    log' = log.append({ kind: "reject", op: "stream" }),
  }

  action step = any {
    click,
    fulfil,
    reject,
    all {
      ui == "live" or ui == "offline",
      attempts' = attempts, a1' = a1, a2' = a2, a3' = a3,
      ui' = ui, unhandled' = unhandled, log' = log,
    },
  }

  // --- properties -------------------------------------------------------
  /// The whole point. A client that keeps trying is not being patient, it is
  /// participating in a retry storm.
  val withinBudget = attempts <= MAX_ATTEMPTS
  /// The spinner does not outlive the budget.
  val noEndlessSpinner = not(a3 == "reject") or ui == "offline"
  /// No rejection escapes its handlers.
  val noUnhandled = not(unhandled)
  /// "Live" is a claim about a connection that answered.
  val noPhantomLive =
    ui != "live" or a1 == "fulfil" or a2 == "fulfil" or a3 == "fulfil"
}
