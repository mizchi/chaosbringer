/**
 * The bridge between model vocabulary and this app.
 *
 * Four things the model cannot know:
 *   - `rules`:         which URL each model operation stands for
 *   - `action`:        how to fire the modelled user action
 *   - `uiProbe`:       how to read the app's state back as a model label
 *   - `appDeadlineMs`: the bound the app sets on its own requests
 *
 * Everything else (which outcome each operation gets, in what order, and what
 * the result should be) comes from the plan. The *timing* comes from the
 * measured profile: `settleMs` used to be a hand-picked 1600ms, which is how
 * this repo shipped a probe window shorter than an app deadline and got a
 * false "stuck" verdict. Now it is solved, and a wrong value is an error
 * before the browser launches.
 */
import { readFileSync } from "node:fs";

/**
 * Measured on this repo's dev container with
 * `chaosbringer model calibrate --url … --runs 3`. Regenerate on your own
 * machine: the numbers are a property of the hardware, not of the app. When
 * absent the runner falls back to a deliberately pessimistic default.
 */
const timingProfile = JSON.parse(
  readFileSync(new URL("./profile.json", import.meta.url), "utf8"),
);

export default {
  /**
   * Must match DEADLINE_MS in public/app.js — the fixed variant bounds its
   * load with it, so every timing value is derived from it. The example's
   * test asserts the two stay in step.
   */
  appDeadlineMs: 1200,
  timingProfile,

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

  // No settleMs: it is solved from appDeadlineMs + timingProfile. Set one and
  // it gets validated against them rather than trusted.
};
