/**
 * Bridge for the token-refresh pattern.
 *
 * `statusCode: 401` is the whole trick: the model's `status` outcome stands for
 * "this request's token had expired", and an expired token is a 401, not the
 * default 500. The refresh endpoint itself is never intercepted — the count is
 * what the plan asserts on.
 */
export default {
  rules: {
    me: { urlPattern: /\/api\/me$/, methods: ["GET"] },
    prefs: { urlPattern: /\/api\/prefs$/, methods: ["GET"] },
  },

  /** An expired token reads as 401, so that is what `status` means here. */
  statusCode: 401,

  action: async (page) => {
    await page.getByRole("button", { name: "Load account" }).click();
  },

  uiProbe: async (page) => {
    const state = await page.locator("#app").getAttribute("data-state");
    return state === "loading" ? "stuck" : (state ?? "unknown");
  },

  stateProbe: async (page) =>
    page.evaluate(async () => {
      const res = await fetch(
        `/api/refresh/count?session=${encodeURIComponent(window.__SESSION__)}`,
      );
      const data = await res.json();
      return { refreshes: data.refreshes };
    }),

  /**
   * Two 401s, one 80ms refresh, then the replays. Comfortably inside this,
   * and the refresh latency is what guarantees the two 401s overlap — without
   * it the second could arrive after the first refresh finished, and a
   * stampede would go unobserved.
   */
  settleMs: 700,
};
