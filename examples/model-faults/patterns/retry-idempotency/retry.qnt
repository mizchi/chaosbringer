// Retry safety: one user intent must produce one order.
//
// The pattern this model exists for is not "the request failed" — that case is
// easy. It is "the request succeeded and the client could not tell": the server
// committed the write, the client saw a failure reading the response, and it
// retried. Whether that produces one order or two decides whether customers
// get double-charged, and it is invisible on screen either way.
//
// So the model tracks a server-side observable (`orders`) alongside the UI, and
// the contract is `orders <= 1`.
module retry {
  // One operation: POST /api/order. Occurrence 0 is the first attempt,
  // occurrence 1 is the retry — which is why the model counts attempts.
  var attempts: int
  // Distinct orders the server ended up with. The bridge reads this back from
  // /api/orders/count.
  var orders: int
  // Whether the client believes the write happened.
  var ui: str // idle | loading | placed | error
  // What each attempt did. Terminal-state targets alone are not enough: the
  // shortest witness for "placed with one order" is a first attempt that just
  // works, which never exercises the retry at all. Recording the per-attempt
  // outcome lets the enumeration target the grid instead.
  var first: str // none | fulfil | rejectBefore | rejectAfter
  var second: str
  var unhandled: bool
  var log: List[{ kind: str, op: str }]

  // --- the contract -----------------------------------------------------
  // A correct implementation carries ONE idempotency key across every attempt
  // of the same intent, so a repeated write is deduped rather than duplicated.
  pure val IDEMPOTENT = true
  pure val MAX_ATTEMPTS = 2
  pure val HANDLES_EVERY_REJECTION = true

  /// A write the server commits. Under the contract a repeat is deduped.
  pure def commit(current: int): int =
    if (IDEMPOTENT and current >= 1) current else current + 1

  action init = all {
    attempts' = 0,
    orders' = 0,
    first' = "none",
    second' = "none",
    ui' = "idle",
    unhandled' = false,
    log' = List(),
  }

  // The user clicks "Place order" once. One intent.
  action click = all {
    attempts == 0,
    attempts' = 1,
    orders' = 0,
    first' = "none",
    second' = "none",
    ui' = "loading",
    unhandled' = false,
    log' = List({ kind: "start", op: "-" }),
  }

  /// The attempt reached the server AND the client read the reply.
  action fulfil = all {
    attempts > 0,
    ui == "loading",
    attempts' = attempts,
    orders' = commit(orders),
    first' = if (attempts == 1) "fulfil" else first,
    second' = if (attempts == 2) "fulfil" else second,
    ui' = "placed",
    unhandled' = unhandled,
    log' = log.append({ kind: "fulfil", op: "order" }),
  }

  /// The attempt never reached the server (connection refused, DNS, offline).
  /// Nothing was committed, so a retry is free.
  action rejectBefore = all {
    attempts > 0,
    ui == "loading",
    attempts' = attempts + 1,
    orders' = orders,
    first' = if (attempts == 1) "rejectBefore" else first,
    second' = if (attempts == 2) "rejectBefore" else second,
    ui' = if (attempts >= MAX_ATTEMPTS) "error" else "loading",
    unhandled' = (unhandled or not(HANDLES_EVERY_REJECTION)),
    log' = log.append({ kind: "reject", op: "order" }),
  }

  /// The attempt DID reach the server — it committed — but the client failed
  /// reading the response. This is the dangerous one: the retry is now a
  /// second write unless it is deduped.
  action rejectAfter = all {
    attempts > 0,
    ui == "loading",
    attempts' = attempts + 1,
    orders' = commit(orders),
    first' = if (attempts == 1) "rejectAfter" else first,
    second' = if (attempts == 2) "rejectAfter" else second,
    ui' = if (attempts >= MAX_ATTEMPTS) "error" else "loading",
    unhandled' = (unhandled or not(HANDLES_EVERY_REJECTION)),
    log' = log.append({ kind: "rejectBody", op: "order" }),
  }

  action step = any {
    click,
    fulfil,
    rejectBefore,
    rejectAfter,
    all {
      ui == "placed" or ui == "error",
      attempts' = attempts, orders' = orders, ui' = ui,
      first' = first, second' = second,
      unhandled' = unhandled, log' = log,
    },
  }

  // --- properties -------------------------------------------------------
  /// One intent, at most one order. The whole point.
  val noDoubleWrite = orders <= 1
  /// No rejection escapes its handlers.
  val noUnhandled = not(unhandled)
  /// The UI never claims success without a committed order.
  val noPhantomSuccess = ui != "placed" or orders >= 1
}
