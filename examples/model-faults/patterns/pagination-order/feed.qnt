// Pagination order: page 2 must not overtake page 1.
//
// Two "load more" clicks issue two requests, and nothing about the network
// guarantees they return in the order they left. An app that appends on arrival
// is correct exactly as long as the network is — and when page 1 is slow, it
// renders the right number of rows, under the right label, with no error
// anywhere, in the wrong order.
//
// What this model deliberately does NOT state is the ordering itself. It says
// how many rows are on screen and what the app should be reporting; "the rows
// are in ascending order and none is repeated" is a rule about *this app's*
// DOM, so it belongs in the bridge's `uiInvariants`, declared once, and is
// checked for every plan that ends in that label. A model that enumerated
// orderings would be specifying the implementation rather than the contract —
// and would have to repeat itself in every plan.
//
// So this is the pattern where the count is right and the page is wrong. Only
// the invariant separates them.
module feed {
  // Pages the app fetched. Occurrence 0 is page 1, occurrence 1 is page 2 —
  // separate operations, because a plan has to slow one and not the other.
  var loaded: int
  // Rows on screen. Two per page, and the model's only quantitative claim.
  var items: int
  // Pages that failed. A later success must not paint over an earlier gap.
  var failed: int
  // Per-page outcome. Terminal-state targets alone would not distinguish the
  // race from the happy path — both end with four rows and a ready banner.
  var first: str // none | fulfil | slow | rejectBefore
  var second: str
  var ui: str // idle | loading | ready | error
  var unhandled: bool
  var log: List[{ kind: str, op: str }]

  // --- the contract -----------------------------------------------------
  pure val ROWS_PER_PAGE = 2
  pure val HANDLES_EVERY_REJECTION = true

  action init = all {
    loaded' = 0,
    items' = 0,
    failed' = 0,
    first' = "none",
    second' = "none",
    ui' = "idle",
    unhandled' = false,
    log' = List(),
  }

  /// Both clicks happen before either response lands — that is what makes the
  /// race possible, and why the model advances `loaded` on the click rather
  /// than on the reply.
  action click = all {
    loaded < 2,
    loaded' = loaded + 1,
    items' = items,
    failed' = failed,
    first' = first,
    second' = second,
    ui' = "loading",
    unhandled' = unhandled,
    log' = log,
  }

  /// A page that arrives promptly.
  action fulfil = all {
    loaded > 0,
    (loaded == 1 and first == "none") or (loaded == 2 and second == "none"),
    loaded' = loaded,
    items' = items + ROWS_PER_PAGE,
    failed' = failed,
    first' = if (loaded == 1) "fulfil" else first,
    second' = if (loaded == 2) "fulfil" else second,
    ui' = if (failed > 0) "error" else "ready",
    unhandled' = unhandled,
    log' = log.append({ kind: "fulfil", op: if (loaded == 1) "page1" else "page2" }),
  }

  /// A page that is slow but still inside the app's own bound. It must render,
  /// and it must render in its place — this is the whole pattern.
  action slow = all {
    loaded > 0,
    (loaded == 1 and first == "none") or (loaded == 2 and second == "none"),
    loaded' = loaded,
    items' = items + ROWS_PER_PAGE,
    failed' = failed,
    first' = if (loaded == 1) "slow" else first,
    second' = if (loaded == 2) "slow" else second,
    ui' = if (failed > 0) "error" else "ready",
    unhandled' = unhandled,
    log' = log.append({ kind: "slow", op: if (loaded == 1) "page1" else "page2" }),
  }

  /// A page that never arrived. Its rows are simply absent, and the banner has
  /// to say so — a gap the user cannot see is worse than an error they can.
  action rejectBefore = all {
    loaded > 0,
    (loaded == 1 and first == "none") or (loaded == 2 and second == "none"),
    loaded' = loaded,
    items' = items,
    failed' = failed + 1,
    first' = if (loaded == 1) "rejectBefore" else first,
    second' = if (loaded == 2) "rejectBefore" else second,
    ui' = "error",
    unhandled' = (unhandled or not(HANDLES_EVERY_REJECTION)),
    log' = log.append({ kind: "reject", op: if (loaded == 1) "page1" else "page2" }),
  }

  action step = any {
    click,
    fulfil,
    slow,
    rejectBefore,
    all {
      first != "none",
      second != "none",
      loaded' = loaded, items' = items, failed' = failed,
      first' = first, second' = second,
      ui' = ui, unhandled' = unhandled, log' = log,
    },
  }

  // --- properties -------------------------------------------------------
  /// Every page that arrived is on screen, whole. Two rows or none.
  val noPartialPage = items % ROWS_PER_PAGE == 0
  /// A gap is never reported as success.
  val noGreenOverGap = failed == 0 or ui != "ready"
  /// No rejection escapes its handlers.
  val noUnhandled = not(unhandled)
  /// Rows only appear for pages that were asked for.
  val noPhantomRows = items <= loaded * ROWS_PER_PAGE
}
