// Optimistic UI: the screen must never outrun the server.
//
// An optimistic update is a bet — the row is on screen before anything is
// committed — and the app owes the user a correction when the bet loses. The
// naive contract is "roll back on error", and it is wrong: a connection that
// never reached the server and a response body that could not be read look
// identical from the `catch`, and they need opposite corrections. Rolling back
// the second one hides a note the server is holding.
//
// So the contract this model states is: **in any terminal state, the screen
// shows exactly what the server has** — and the only way to know that after an
// ambiguous failure is to ask. Which is why the model counts list reads.
//
// That count is the interesting part. On the `rejectAfter` outcome (the server
// committed, the client could not read the reply) an app that keeps the row
// without asking ends up with the *right* screen for the *wrong* reason, and
// no state assertion can tell the two apart. `listCalls` can.
module rollback {
  // GETs the app issued on the list operation. Occurrence 0 is the page load;
  // a reconcile after a failed write is occurrence 1.
  var listCalls: int
  // POSTs on the write operation. One user intent must be one write.
  var noteCalls: int
  // Notes the server ended up holding. Read back from /api/notes/count.
  var committed: int
  // Rows on screen, optimistic ones included.
  var shown: int
  // What happened to the write. Terminal-state targets alone are not enough:
  // recording the outcome is what lets the enumeration cover the grid.
  var write: str // none | pending | fulfil | rejectBefore | serverError | rejectAfter
  var ui: str // idle | saving | saved | error
  var unhandled: bool
  var log: List[{ kind: str, op: str }]

  // --- the contract -----------------------------------------------------
  /// A correct implementation re-reads the list after an ambiguous failure
  /// instead of guessing which correction to apply.
  pure val RECONCILES = true
  pure val HANDLES_EVERY_REJECTION = true

  /// What the screen shows once the app has corrected itself: server truth if
  /// it asked, whatever it optimistically rendered if it did not.
  pure def afterFailure(serverHas: int, optimistic: int): int =
    if (RECONCILES) serverHas else optimistic

  /// The reconcile read, when the app performs one.
  pure def reconcileRead(calls: int): int =
    if (RECONCILES) calls + 1 else calls

  action init = all {
    listCalls' = 0,
    noteCalls' = 0,
    committed' = 0,
    shown' = 0,
    write' = "none",
    ui' = "idle",
    unhandled' = false,
    log' = List(),
  }

  /// The page reads the list on load. Stated explicitly, because it is what
  /// makes a reconcile occurrence 1 rather than 0 — the same trap the
  /// cloudflare-worker model documents.
  action load = all {
    listCalls == 0,
    listCalls' = 1,
    noteCalls' = noteCalls,
    committed' = committed,
    shown' = committed,
    write' = write,
    ui' = "idle",
    unhandled' = unhandled,
    log' = log.append({ kind: "fulfil", op: "list" }),
  }

  /// The user adds a note. The row appears immediately — that is what makes
  /// the update optimistic, and what creates the obligation to correct it.
  action add = all {
    listCalls == 1,
    write == "none",
    listCalls' = listCalls,
    noteCalls' = noteCalls + 1,
    committed' = committed,
    shown' = committed + 1,
    write' = "pending",
    ui' = "saving",
    unhandled' = unhandled,
    log' = log,
  }

  /// The write committed and the client read the reply. Nothing to correct.
  action fulfil = all {
    write == "pending",
    listCalls' = listCalls,
    noteCalls' = noteCalls,
    committed' = committed + 1,
    shown' = shown,
    write' = "fulfil",
    ui' = "saved",
    unhandled' = unhandled,
    log' = log.append({ kind: "fulfil", op: "note" }),
  }

  /// The request never reached the server: connection refused, DNS, offline.
  /// Nothing was committed, so the optimistic row is a lie.
  action rejectBefore = all {
    write == "pending",
    listCalls' = reconcileRead(listCalls),
    noteCalls' = noteCalls,
    committed' = committed,
    shown' = afterFailure(committed, shown),
    write' = "rejectBefore",
    ui' = "error",
    unhandled' = (unhandled or not(HANDLES_EVERY_REJECTION)),
    log' = log.append({ kind: "reject", op: "note" }),
  }

  /// The server refused the write (500). Also nothing committed — but the app
  /// cannot know that without asking, which is the point.
  action serverError = all {
    write == "pending",
    listCalls' = reconcileRead(listCalls),
    noteCalls' = noteCalls,
    committed' = committed,
    shown' = afterFailure(committed, shown),
    write' = "serverError",
    ui' = "error",
    unhandled' = (unhandled or not(HANDLES_EVERY_REJECTION)),
    log' = log.append({ kind: "serverError", op: "note" }),
  }

  /// The server committed and the *reply* failed. The row on screen happens to
  /// be correct; an app that rolled back would have deleted a real note, and
  /// an app that guessed right learned nothing. Only the reconcile separates
  /// the two, so only `listCalls` can judge this state.
  action rejectAfter = all {
    write == "pending",
    listCalls' = reconcileRead(listCalls),
    noteCalls' = noteCalls,
    committed' = committed + 1,
    shown' = afterFailure(committed + 1, shown),
    write' = "rejectAfter",
    ui' = "error",
    unhandled' = (unhandled or not(HANDLES_EVERY_REJECTION)),
    log' = log.append({ kind: "rejectBody", op: "note" }),
  }

  action step = any {
    load,
    add,
    fulfil,
    rejectBefore,
    serverError,
    rejectAfter,
    all {
      ui == "saved" or ui == "error",
      listCalls' = listCalls, noteCalls' = noteCalls,
      committed' = committed, shown' = shown,
      write' = write, ui' = ui, unhandled' = unhandled, log' = log,
    },
  }

  // --- properties -------------------------------------------------------
  /// Terminal only: mid-flight, the screen is *supposed* to be ahead of the
  /// server. Asserting otherwise would forbid optimistic UI itself.
  val settled = ui == "saved" or ui == "error"
  /// The whole contract. A phantom row (shown > committed) is a note the user
  /// believes they saved; a lost row (shown < committed) is one they think
  /// they lost, and will write again.
  val screenMatchesServer = not(settled) or shown == committed
  /// No rejection escapes its handlers.
  val noUnhandled = not(unhandled)
  /// "Saved" is a claim about the server, not about the DOM.
  val noPhantomSuccess = ui != "saved" or committed >= 1
  /// One user intent, one write. The optimistic row must not resubmit.
  val noDoubleWrite = noteCalls <= 1
}
