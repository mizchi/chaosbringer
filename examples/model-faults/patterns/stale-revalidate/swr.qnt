// Stale-while-revalidate: serving the cached copy is allowed, keeping it is not.
//
// The read-side twin of optimistic UI, and it inverts the usual reasoning.
// "The screen shows old data" cannot be the bug, because showing the cached
// copy instantly is the entire point of the pattern. What makes it a bug is
// *ending* there: the app owes the user either the newer copy it received or an
// honest label saying which one they are looking at.
//
// So this model separates two things a single "shown" variable would conflate:
// what the app *received* and what it *rendered*. The contract is that a page
// claiming to be up to date has rendered what it received — which is a claim no
// single observable can carry, and the reason `received` exists here at all.
//
// The failure this catches is the one that looks perfect in a profiler: the
// request goes out, the response comes back, the JSON parses, and nothing
// consumes it. Every error path a reviewer thinks to exercise behaves
// correctly, because the bug lives on the success path.
module swr {
  // GETs on the profile operation. Occurrence 0 is the page load, occurrence 1
  // is the revalidation — and a pattern about revalidating has to be able to
  // say that the second one happened.
  var calls: int
  // The newest revision the app has received, whatever it chose to render.
  var received: int
  // The revision on screen.
  var shown: int
  var ui: str // idle | stale | fresh | error
  // What the revalidation did. Terminal-state targets alone would collapse the
  // two failure modes into one, and the whole point of enumerating them is that
  // the *implementation* collapses them and the model does not.
  var revalidate: str // none | fulfil | reject | serverError
  var unhandled: bool
  var log: List[{ kind: str, op: str }]

  // --- the contract -----------------------------------------------------
  /// A correct implementation renders what it received.
  pure val RENDERS_WHAT_IT_RECEIVED = true
  pure val HANDLES_EVERY_REJECTION = true

  pure def rendered(got: int, onScreen: int): int =
    if (RENDERS_WHAT_IT_RECEIVED) got else onScreen

  action init = all {
    calls' = 0,
    received' = 0,
    shown' = 0,
    ui' = "idle",
    revalidate' = "none",
    unhandled' = false,
    log' = List(),
  }

  /// The page load. Nothing is cached yet, so there is nothing to serve stale.
  action load = all {
    calls == 0,
    calls' = 1,
    received' = 1,
    shown' = 1,
    ui' = "fresh",
    revalidate' = revalidate,
    unhandled' = unhandled,
    log' = log.append({ kind: "fulfil", op: "profile" }),
  }

  /// The user asks for a refresh. The cached copy goes up immediately and the
  /// revalidation request leaves — both, in that order, which is the pattern.
  action click = all {
    calls == 1,
    revalidate == "none",
    calls' = 2,
    received' = received,
    shown' = shown,
    ui' = "stale",
    revalidate' = "pending",
    unhandled' = unhandled,
    log' = log,
  }

  /// The revalidation returned something newer. Rendering it is the contract.
  action fulfil = all {
    revalidate == "pending",
    calls' = calls,
    received' = received + 1,
    shown' = rendered(received + 1, shown),
    ui' = "fresh",
    revalidate' = "fulfil",
    unhandled' = unhandled,
    log' = log.append({ kind: "fulfil", op: "profile" }),
  }

  /// The revalidation never reached the server.
  action reject = all {
    revalidate == "pending",
    calls' = calls,
    received' = received,
    shown' = shown,
    ui' = "stale",
    revalidate' = "reject",
    unhandled' = (unhandled or not(HANDLES_EVERY_REJECTION)),
    log' = log.append({ kind: "reject", op: "profile" }),
  }

  /// The server refused it. A different cause, the same obligation — and, in
  /// most implementations, the same code. That is a finding, not a redundancy:
  /// see the pattern's note on collapsed plans.
  action serverError = all {
    revalidate == "pending",
    calls' = calls,
    received' = received,
    shown' = shown,
    ui' = "stale",
    revalidate' = "serverError",
    unhandled' = (unhandled or not(HANDLES_EVERY_REJECTION)),
    log' = log.append({ kind: "serverError", op: "profile" }),
  }

  action step = any {
    load,
    click,
    fulfil,
    reject,
    serverError,
    all {
      revalidate == "fulfil" or revalidate == "reject" or revalidate == "serverError",
      calls' = calls, received' = received, shown' = shown,
      ui' = ui, revalidate' = revalidate,
      unhandled' = unhandled, log' = log,
    },
  }

  // --- properties -------------------------------------------------------
  /// The whole contract. "Up to date" is a claim about what was received, not
  /// about what a request returned to nobody.
  val noSilentStale = ui != "fresh" or shown == received
  /// A cached copy on screen is either labelled or replaced — never silent.
  val staleIsLabelled = shown == received or ui == "stale"
  /// No rejection escapes its handlers.
  val noUnhandled = not(unhandled)
  /// The revision on screen is one the app actually received. True by
  /// construction — every assignment to `shown` is either `received` or the
  /// value it already had — so `enumerate.sh` deliberately does NOT target it:
  /// a query with one possible answer is not a proof. Kept because it reads as
  /// the sanity check it is.
  val noInventedRevision = shown <= received
}
