// Token refresh: one expired token, one refresh.
//
// A page loads two resources for one user action. When the token has expired
// both come back 401 at the same moment, and each one wants to refresh. A
// correct implementation shares one in-flight refresh; a naive one starts a
// refresh per 401 — a stampede against the one endpoint you least want to
// overload, and on a rotating-refresh-token backend the second refresh
// invalidates the first and logs the user out.
//
// Both render identically, so the contract is stated over a server-side
// counter: `refreshes <= 1`.
module token {
  pure val OPS = Set("me", "prefs")

  // "fresh"  the request succeeded on the first try
  // "stale"  it came back 401 and is waiting for a refresh
  // "replayed" it was retried after the refresh and succeeded
  var opState: str -> str
  // Refreshes the server actually served. The bridge reads this back from
  // /api/refresh/count.
  var refreshes: int
  var ui: str // idle | loading | ready | error
  var unhandled: bool
  var log: List[{ kind: str, op: str }]

  // --- the contract -----------------------------------------------------
  /// One shared in-flight refresh, however many requests hit 401 together.
  pure val SHARED_REFRESH = true
  /// The original request is replayed after the refresh, so the user never
  /// sees an error caused by an expiry the app handled.
  pure val REPLAYS_AFTER_REFRESH = true

  pure def allAre(s: str -> str, want: str): bool = OPS.forall(o => s.get(o) == want)
  pure def anyIs(s: str -> str, want: str): bool = OPS.exists(o => s.get(o) == want)
  pure def settled(s: str -> str): bool =
    OPS.forall(o => s.get(o) == "fresh" or s.get(o) == "replayed")

  pure def expectedUi(s: str -> str): str =
    if (anyIs(s, "stale")) "loading"
    else if (settled(s)) (if (REPLAYS_AFTER_REFRESH) "ready" else "error")
    else "loading"

  action init = all {
    opState' = OPS.mapBy(_ => "unstarted"),
    refreshes' = 0,
    ui' = "idle",
    unhandled' = false,
    log' = List(),
  }

  action click = all {
    ui == "idle",
    opState' = OPS.mapBy(_ => "pending"),
    refreshes' = 0,
    ui' = "loading",
    unhandled' = false,
    log' = List({ kind: "start", op: "-" }),
  }

  /// The token was still valid for this request.
  action ok(op: str): bool = all {
    opState.get(op) == "pending",
    val nx = opState.set(op, "fresh")
    all {
      opState' = nx,
      refreshes' = refreshes,
      ui' = expectedUi(nx),
      unhandled' = unhandled,
      log' = log.append({ kind: "fulfil", op: op }),
    },
  }

  /// 401: the token has expired for this request. A plan injects this as a
  /// 401 status on the first occurrence of the operation.
  action expired(op: str): bool = all {
    opState.get(op) == "pending",
    val nx = opState.set(op, "stale")
    all {
      opState' = nx,
      refreshes' = refreshes,
      ui' = expectedUi(nx),
      unhandled' = unhandled,
      log' = log.append({ kind: "status", op: op }),
    },
  }

  /// The refresh happens and every stale request is replayed. Under the
  /// contract this costs exactly one refresh no matter how many were stale —
  /// which is the whole assertion.
  action refreshAndReplay = all {
    anyIs(opState, "stale"),
    val nx = OPS.mapBy(o => if (opState.get(o) == "stale") "replayed" else opState.get(o))
    all {
      opState' = nx,
      refreshes' = if (SHARED_REFRESH) 1 else refreshes + 1,
      ui' = expectedUi(nx),
      unhandled' = unhandled,
      log' = log.append({ kind: "refresh", op: "-" }),
    },
  }

  action step = any {
    click,
    nondet op = OPS.oneOf() ok(op),
    nondet op = OPS.oneOf() expired(op),
    refreshAndReplay,
    all {
      ui == "ready" or ui == "error",
      opState' = opState, refreshes' = refreshes, ui' = ui,
      unhandled' = unhandled, log' = log,
    },
  }

  // --- properties -------------------------------------------------------
  /// One expiry, one refresh — however many requests hit 401 together.
  val noStampede = refreshes <= 1
  /// An expiry the app handled must never surface as an error.
  val noSpuriousError = ui != "error"
  val noUnhandled = not(unhandled)
}
