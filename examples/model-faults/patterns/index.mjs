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
];
