/**
 * Bridge for the token-refresh pattern.
 *
 * `statusCode: 401` is the whole trick: the model's `status` outcome stands for
 * "this request's token had expired", and an expired token is a 401 — for the
 * protected resources *and* for the refresh itself, where it means the refresh
 * token had expired too.
 *
 * The refresh endpoint used to be absent from `rules`, which made it absent
 * from the enumeration: no plan could fail it, so the rung where a client
 * retries a failing refresh forever — the auth-loop outage this pattern is
 * named for — was unreachable from every plan, and both variants passed. It is
 * an operation now.
 */
export default {
  rules: {
    me: { urlPattern: /\/api\/me$/, methods: ["GET"] },
    prefs: { urlPattern: /\/api\/prefs$/, methods: ["GET"] },
    // POST only, and `(\?|$)` rather than `$`: this rule carries an
    // `expect.calls` bound, and there the regex defines the number being
    // asserted rather than selecting requests for it. `/api/refresh/count` —
    // what the state probe reads — matches neither, because `(\?|$)` cannot
    // step over the `/`.
    refresh: { urlPattern: /\/api\/refresh(\?|$)/, methods: ["POST"] },
  },

  /** An expired token reads as 401, so that is what `status` means here. */
  statusCode: 401,

  action: async (page) => {
    await page.getByRole("button", { name: "Load account" }).click();
  },

  uiProbe: async (page) => {
    const state = await page.locator("#app").getAttribute("data-state");
    // Still "loading" after the window means the app never resolved the
    // expiry either way — the shape a refresh retry loop has from the outside.
    return state === "loading" ? "stuck" : (state ?? "unknown");
  },

  /**
   * The endpoint's own count: refreshes the server *served*. The plans also
   * carry `expect.calls.refresh`, which is the number the client *issued* —
   * different numbers on the rung where the refresh 401s, since a response the
   * fault layer supplies never reaches the server. Neither is redundant: the
   * first is the endpoint's load, the second is the client's behaviour.
   */
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
   *
   * No appDeadlineMs: nothing here is bounded by the app, and the failing-
   * refresh rung is deliberately *not* given one. A client that retries a
   * failed refresh is unbounded by definition, so there is no ladder to
   * declare — what the plan asserts is the count, and the count grows for as
   * long as anyone watches.
   */
  settleMs: 700,
};
