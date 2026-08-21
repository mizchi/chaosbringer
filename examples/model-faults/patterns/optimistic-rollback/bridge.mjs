/**
 * Bridge for the optimistic-rollback pattern.
 *
 * Three things worth noting, all of them consequences of the shape of a REST
 * collection rather than of this example:
 *
 *  - **One URL, two operations.** `GET /api/notes` reads and `POST /api/notes`
 *    writes, so both rules need a method filter. Without one a plan fires on
 *    whichever call arrives first, which here would be the page load.
 *  - **`/api/notes/count` must not match either rule.** The regexes are
 *    anchored for that reason: the state probe's own fetch would otherwise be
 *    counted as a list read and inflate `expect.calls`.
 *  - **`shown` is read from the DOM, `committed` from the server.** The whole
 *    pattern is about those two disagreeing, so one probe reads both — a probe
 *    that read only one of them could not see the bug at all.
 */
export default {
  rules: {
    list: { urlPattern: /\/api\/notes(\?|$)/, methods: ["GET"] },
    note: { urlPattern: /\/api\/notes(\?|$)/, methods: ["POST"] },
  },

  action: async (page) => {
    await page.getByRole("button", { name: "Add note" }).click();
  },

  uiProbe: async (page) => {
    const state = await page.locator("#app").getAttribute("data-state");
    // Still "saving" when the settle window elapsed means the write never
    // resolved either way — not a state the contract allows.
    return state === "saving" ? "stuck" : (state ?? "unknown");
  },

  stateProbe: async (page) =>
    page.evaluate(async () => {
      const session = window.__SESSION__;
      const res = await fetch(`/api/notes/count?session=${encodeURIComponent(session)}`);
      const data = await res.json();
      return {
        committed: data.notes,
        shown: document.querySelectorAll("#notes li").length,
      };
    }),

  /** One POST, one reconcile GET, no retries or backoff. */
  settleMs: 600,
};
