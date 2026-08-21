/**
 * The pattern index. One entry per real-world async shape: the page it runs
 * against, the model that specifies it, and the bug class it exists to catch.
 *
 * Adding a pattern is mechanical — model + enumerate.sh + plans + bridge, then
 * a row here — which is the point.
 */
export const PATTERNS = [
  {
    name: "retry-idempotency",
    path: "/retry",
    spec: "patterns/retry-idempotency/retry.qnt",
    catches:
      "a retry that writes twice. The dangerous failure is the one where the server committed " +
      "and the client could not read the reply: without one idempotency key per intent, the " +
      "retry is a second order, and the UI looks identical either way.",
  },
  {
    name: "token-refresh",
    path: "/token",
    spec: "patterns/token-refresh/token.qnt",
    catches:
      "a refresh stampede. Two requests hitting 401 together must share one in-flight refresh; " +
      "one refresh per 401 hammers the endpoint you least want to overload, and on a rotating " +
      "refresh token the second one invalidates the first and logs the user out.",
  },
  {
    name: "optimistic-rollback",
    path: "/optimistic",
    spec: "patterns/optimistic-rollback/rollback.qnt",
    catches:
      "an optimistic row the server never took. \"Roll back on error\" is the wrong contract: a " +
      "request that never arrived and a reply that could not be read need opposite corrections, " +
      "and only asking the server tells them apart. The app that guesses is right half the time " +
      "and has verified nothing either way.",
  },
  {
    name: "pagination-order",
    path: "/feed",
    spec: "patterns/pagination-order/feed.qnt",
    catches:
      "page 2 overtaking page 1. Two \"load more\" clicks are two requests, and nothing about " +
      "the network returns them in the order they left. An app that appends on arrival renders " +
      "the right number of rows, under the right banner, in the wrong order — the one bug in " +
      "this library that no per-plan expectation can see.",
  },
  {
    name: "timeout-ladder",
    path: "/slow",
    spec: "patterns/timeout-ladder/ladder.qnt",
    catches:
      "a request with no bound. Slow and never are different failures: the first must still " +
      "render, the second must give up. An unbounded app handles the slow case perfectly, which " +
      "is why the missing bound survives review — and spins forever on the other.",
  },
];
