/**
 * Bridge for the retry / idempotency pattern.
 *
 * The notable part is `stateProbe`: the bug this pattern hunts is invisible in
 * the UI. A retry that writes twice shows the same "Order placed" banner as one
 * that writes once — the difference is only in the server's order count, so the
 * model asserts on that and the probe reads it back.
 */
export default {
  rules: {
    // POST only: the count endpoint is a GET on a neighbouring path and must
    // never be intercepted by a plan.
    order: { urlPattern: /\/api\/order$/, methods: ["POST"] },
  },

  action: async (page) => {
    await page.getByRole("button", { name: "Place order" }).click();
  },

  uiProbe: async (page) => {
    const state = await page.locator("#app").getAttribute("data-state");
    // Still loading when the settle window elapsed means the retry never
    // finished — not a state the contract allows.
    return state === "loading" ? "stuck" : (state ?? "unknown");
  },

  stateProbe: async (page) =>
    page.evaluate(async () => {
      const session = window.__SESSION__;
      const res = await fetch(`/api/orders/count?session=${encodeURIComponent(session)}`);
      const data = await res.json();
      return { orders: data.orders };
    }),

  /** Two attempts plus a 50ms backoff finish well inside this. */
  settleMs: 600,
};
