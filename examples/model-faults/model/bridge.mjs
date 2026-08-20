/**
 * The bridge between model vocabulary and this app.
 *
 * Three things the model cannot know:
 *   - `rules`:    which URL each model operation stands for
 *   - `action`:   how to fire the modelled user action
 *   - `uiProbe`:  how to read the app's state back as a model label
 *
 * Everything else (which outcome each operation gets, in what order, and what
 * the result should be) comes from the plan.
 */
export default {
  rules: {
    cart: /\/api\/cart$/,
    shipping: /\/api\/shipping$/,
  },

  action: async (page) => {
    await page.getByRole("button", { name: "Load order" }).click();
  },

  /**
   * `data-state` carries the app's own state machine. The one translation the
   * probe performs: a page still in `loading` when the settle window has
   * elapsed is what the model calls `stuck` — that is the definition of a
   * request nothing bounds.
   */
  uiProbe: async (page) => {
    const state = await page.locator("#app").getAttribute("data-state");
    return state === "loading" ? "stuck" : (state ?? "unknown");
  },

  /**
   * Long enough for a bounded load to finish and for an escaping rejection to
   * reach `unhandledrejection`; short enough that 16 plans stay quick. The
   * fixed variant's own deadline is 1200ms, so this must exceed it.
   */
  settleMs: 1600,
};
