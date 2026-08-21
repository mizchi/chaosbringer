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
 *  - **…and counting them is not enough.** `expect.calls` proves the reconcile
 *    *request*; `committed == shown` proves the arithmetic. Neither proves the
 *    app read the answer: `void refetch()` / `invalidateQueries()` next to a
 *    local promotion issues the GET, drops the body, keeps a row under an id
 *    only that tab has ever heard of, and satisfies both. So the invariant
 *    below compares row *identity* against the server's own ids.
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

  uiInvariants: {
    // "*" — true under every label the model can predict, including "error":
    // a screen that could not confirm a save still owes the user rows that
    // exist. This is the assertion `expect.calls` cannot make. The count says
    // the app asked; the ids say it listened.
    //
    // `/api/notes/count` on purpose: it matches neither `list` nor `note`
    // (both anchored with `(\?|$)` right after `notes`), so this fetch cannot
    // inflate the reconcile count the pattern asserts on. Reading
    // `/api/notes?session=…` here would be counted as a list read and break
    // `expect.calls` in every plan.
    "*": async (page) =>
      page.evaluate(async () => {
        const shown = [...document.querySelectorAll("#notes li")].map(
          (li) => li.dataset.id ?? "(no id)",
        );
        const res = await fetch(
          `/api/notes/count?session=${encodeURIComponent(window.__SESSION__)}`,
        );
        const held = (await res.json()).ids;
        if (shown.join() === held.join()) return "";
        return (
          `the screen shows note id(s) [${shown.join(", ")}] while the server holds ` +
          `[${held.join(", ")}] — a row whose id no other client can address is a row ` +
          `the app never verified`
        );
      }),
  },

  /** One POST, one reconcile GET, no retries or backoff. */
  settleMs: 600,
};
