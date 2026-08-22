// Token refresh: one expired token, one refresh — and one rung where the
// refresh itself fails.
//
// A page loads two resources for one user action. When the token has expired
// both come back 401 at the same moment, and each one wants to refresh. A
// correct implementation shares one in-flight refresh; a naive one starts a
// refresh per 401 — a stampede against the one endpoint you least want to
// overload, and on a rotating-refresh-token backend the second refresh
// invalidates the first and logs the user out.
//
// Both render identically, so the contract is stated over counters:
// `refreshCalls <= MAX_REFRESH`.
//
// The refresh used to be one atomic `refreshAndReplay` that always succeeded,
// which made the endpoint invisible to the enumeration: no plan could fail it,
// and a client that retries a failed refresh forever satisfied every plan while
// making 46 POSTs in 1.5s. That is where an auth-loop outage actually comes
// from, so the refresh is now an *operation* (`op: "refresh"`, so the bridge
// can fault it) split into `refresh` + `replay`, with a rung where it 401s.
//
// Two counters, because the failing rung is exactly where they separate:
//   refreshCalls  POSTs the client issued          -> expect.calls.refresh
//   refreshes     …of which the endpoint answered  -> expect.state.refreshes
// A refresh the gateway rejects is a request the client made and the server
// never served. One number is read from the fault layers, the other from
// /api/refresh/count, and an app that hammers a failing endpoint moves both.
module token {
  pure val OPS = Set("me", "prefs")

  // "fresh"  the request succeeded on the first try
  // "stale"  it came back 401 and is waiting for a refresh
  // "replayed" it was retried after the refresh and succeeded
  var opState: str -> str
  // Refresh POSTs the client issued, served or not. The fault layers count
  // these; `--calls-var refresh=refreshCalls` lifts the total into
  // expect.calls, which is where the *load* claim belongs.
  var refreshCalls: int
  // …of which the endpoint actually answered. The bridge reads this back from
  // /api/refresh/count, so it is expect.state.
  var refreshes: int
  // "none" not attempted | "ok" served | "failed" the refresh itself 401'd
  var refreshState: str
  var ui: str // idle | loading | ready | signedOut | error
  var unhandled: bool
  var log: List[{ kind: str, op: str }]

  // --- the contract -----------------------------------------------------
  /// One shared in-flight refresh, however many requests hit 401 together.
  pure val SHARED_REFRESH = true
  /// The original request is replayed after the refresh, so the user never
  /// sees an error caused by an expiry the app handled.
  pure val REPLAYS_AFTER_REFRESH = true
  /// A refresh that fails is *not* retried: the app stops and says so. The
  /// alternative is a loop against the endpoint that is already failing —
  /// invisible from one tab, an outage across a fleet.
  pure val REFRESH_BOUNDED = true
  /// Nothing on the refresh path escapes its handlers.
  pure val HANDLES_EVERY_REJECTION = true
  /// One expiry wave, one refresh.
  pure val MAX_REFRESH = 1

  pure def allAre(s: str -> str, want: str): bool = OPS.forall(o => s.get(o) == want)
  pure def anyIs(s: str -> str, want: str): bool = OPS.exists(o => s.get(o) == want)
  pure def settled(s: str -> str): bool =
    OPS.forall(o => s.get(o) == "fresh" or s.get(o) == "replayed")

  /// What the screen says, given the requests and the refresh. A refresh that
  /// failed under the contract is a terminal, user-visible state; without the
  /// bound the app is still looping and the spinner never ends.
  pure def expectedUi(s: str -> str, rs: str): str =
    if (rs == "failed" and REFRESH_BOUNDED) "signedOut"
    else if (anyIs(s, "stale")) "loading"
    else if (settled(s)) (if (REPLAYS_AFTER_REFRESH) "ready" else "error")
    else "loading"

  action init = all {
    opState' = OPS.mapBy(_ => "unstarted"),
    refreshCalls' = 0,
    refreshes' = 0,
    refreshState' = "none",
    ui' = "idle",
    unhandled' = false,
    log' = List(),
  }

  action click = all {
    ui == "idle",
    opState' = OPS.mapBy(_ => "pending"),
    refreshCalls' = 0,
    refreshes' = 0,
    refreshState' = "none",
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
      refreshCalls' = refreshCalls,
      refreshes' = refreshes,
      refreshState' = refreshState,
      ui' = expectedUi(nx, refreshState),
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
      refreshCalls' = refreshCalls,
      refreshes' = refreshes,
      refreshState' = refreshState,
      ui' = expectedUi(nx, refreshState),
      unhandled' = unhandled,
      log' = log.append({ kind: "status", op: op }),
    },
  }

  /// The refresh the stale requests are waiting for, served. Under
  /// the contract this costs exactly one POST no matter how many requests were
  /// stale — which is the whole assertion.
  action refresh = all {
    anyIs(opState, "stale"),
    refreshState == "none",
    val n = if (SHARED_REFRESH) 1 else refreshCalls + 1
    all {
      opState' = opState,
      refreshCalls' = n,
      refreshes' = n,
      refreshState' = "ok",
      ui' = expectedUi(opState, "ok"),
      unhandled' = unhandled,
      log' = log.append({ kind: "fulfil", op: "refresh" }),
    },
  }

  /// The refresh itself comes back 401 — the refresh token had expired too.
  /// This is the rung the stampede lives on: one POST under the contract, and
  /// without the bound one POST per retry, forever, against an endpoint that is
  /// already failing. The gateway answered it, so `refreshes` — what the
  /// endpoint actually served — does not move while `refreshCalls` does.
  action refreshFailed = all {
    anyIs(opState, "stale"),
    any { refreshState == "none", not(REFRESH_BOUNDED) },
    opState' = opState,
    refreshCalls' = refreshCalls + 1,
    refreshes' = refreshes,
    refreshState' = "failed",
    ui' = expectedUi(opState, "failed"),
    unhandled' = (unhandled or not(HANDLES_EVERY_REJECTION)),
    log' = log.append({ kind: "status", op: "refresh" }),
  }

  /// The stale requests are re-issued with the new token. Not an injection
  /// point: it is the app re-issuing occurrence 1 of an operation the plan
  /// already pinned at occurrence 0, so it appends nothing to the log.
  action replay = all {
    refreshState == "ok",
    anyIs(opState, "stale"),
    val nx = OPS.mapBy(o => if (opState.get(o) == "stale") "replayed" else opState.get(o))
    all {
      opState' = nx,
      refreshCalls' = refreshCalls,
      refreshes' = refreshes,
      refreshState' = refreshState,
      ui' = expectedUi(nx, refreshState),
      unhandled' = unhandled,
      log' = log,
    },
  }

  action step = any {
    click,
    nondet op = OPS.oneOf() ok(op),
    nondet op = OPS.oneOf() expired(op),
    refresh,
    refreshFailed,
    replay,
    all {
      ui == "ready" or ui == "error" or ui == "signedOut",
      opState' = opState, refreshCalls' = refreshCalls, refreshes' = refreshes,
      refreshState' = refreshState, ui' = ui,
      unhandled' = unhandled, log' = log,
    },
  }

  // --- properties -------------------------------------------------------
  /// One expiry, one refresh — however many requests hit 401 together, and
  /// however the refresh itself turns out.
  val noStampede = refreshCalls <= MAX_REFRESH
  /// An expiry the app handled must never surface as an error.
  val noSpuriousError = ui != "error"
  val noUnhandled = not(unhandled)
  /// A refresh that failed is a state the user is told about, not a loop.
  val saysSoWhenSignedOut = refreshState != "failed" or ui == "signedOut"
}
