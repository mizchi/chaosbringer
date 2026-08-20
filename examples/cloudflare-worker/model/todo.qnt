// "Add a todo" contract for the existing Cloudflare-Worker example app
// (examples/cloudflare-worker/src/app.ts). The app was written months before
// this pipeline existed and is NOT modified here — the model states what a
// correct implementation must do, and every disagreement is a finding.
//
// The flow, as the app implements it:
//   page load            -> GET /api/todos            (refresh)
//   click "Add random"   -> POST /api/todos, then     (write)
//                           GET /api/todos            (refresh again)
module todo {
  // "post"  = POST /api/todos       "list" = GET /api/todos
  var postState: str        // unstarted | pending | fulfilled | rejected | errored | hung
  var listState: str        // unstarted | pending | fulfilled | rejected | bodyRejected
  var listDone: int         // how many list fetches have settled (page load = 1)
  var ui: str               // idle | loading | ready | error | stuck
  var unhandled: bool
  var log: List[{ kind: str, op: str }]

  // The contract.
  pure val HANDLES_EVERY_REJECTION = true
  pure val CHECKS_RESPONSE_STATUS = true
  pure val HAS_TIMEOUT = true

  pure def postFailed(p: str): bool = p == "rejected" or p == "errored"
  pure def listFailed(l: str): bool = l == "rejected" or l == "bodyRejected"

  pure def expectedUi(p: str, l: str): str =
    // A write that failed must be surfaced, whatever the list shows: leaving
    // the old list on screen tells the user their todo was saved.
    if (postFailed(p)) "error"
    else if (p == "hung") (if (HAS_TIMEOUT) "error" else "stuck")
    else if (listFailed(l)) "error"
    else if (p == "fulfilled" and l == "fulfilled") "ready"
    else if (p == "unstarted" and l == "fulfilled") "ready"
    else "loading"

  action init = all {
    postState' = "unstarted",
    listState' = "unstarted",
    listDone' = 0,
    ui' = "idle",
    unhandled' = false,
    log' = List(),
  }

  // Page load: the app refreshes the list before any user action. Modelled
  // explicitly so plan occurrence numbers line up with reality — the
  // post-click refresh is the SECOND fetch of /api/todos, not the first.
  action pageLoad = all {
    listDone == 0,
    postState' = "unstarted",
    listState' = "fulfilled",
    listDone' = 1,
    ui' = "ready",
    unhandled' = unhandled,
    log' = log.append({ kind: "fulfil", op: "list" }),
  }

  // Click "Add random todo": the write goes out.
  action clickAdd = all {
    listDone == 1,
    postState == "unstarted",
    postState' = "pending",
    listState' = listState,
    listDone' = listDone,
    ui' = "loading",
    unhandled' = unhandled,
    log' = log.append({ kind: "start", op: "-" }),
  }

  action settlePost(terminal: str, kind: str): bool = all {
    postState == "pending",
    postState' = terminal,
    listState' = listState,
    listDone' = listDone,
    ui' = expectedUi(terminal, listState),
    unhandled' = (unhandled or not(HANDLES_EVERY_REJECTION)),
    log' = log.append({ kind: kind, op: "post" }),
  }

  // The refresh only happens after a genuinely successful write: a non-2xx
  // response is a failure, not a reason to re-render as if it worked. An app
  // that skips the status check refreshes here anyway — which is exactly the
  // divergence this model is meant to expose.
  action settleList(terminal: str, kind: str): bool = all {
    postState == "fulfilled",
    listDone == 1,
    postState' = postState,
    listState' = terminal,
    listDone' = 2,
    ui' = expectedUi(postState, terminal),
    unhandled' = (unhandled or not(HANDLES_EVERY_REJECTION)),
    log' = log.append({ kind: kind, op: "list" }),
  }

  action step = any {
    pageLoad,
    clickAdd,
    settlePost("fulfilled", "fulfil"),
    settlePost("rejected", "reject"),
    settlePost("errored", "status"),
    settlePost("hung", "hang"),
    settleList("fulfilled", "fulfil"),
    settleList("rejected", "reject"),
    settleList("bodyRejected", "rejectBody"),
    all {
      ui != "idle",
      postState' = postState, listState' = listState, listDone' = listDone,
      ui' = ui, unhandled' = unhandled, log' = log,
    },
  }

  val noUnhandled = not(unhandled)
  val neverStuck = ui != "stuck"
}
