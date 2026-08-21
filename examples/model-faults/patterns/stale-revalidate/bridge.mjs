/**
 * Bridge for the stale-revalidate pattern.
 *
 * The one bridge that asks for `coverageFingerprints`. This pattern's model
 * distinguishes a revalidation that never arrived from one the server refused,
 * and it is worth knowing that the *implementation* does not: both go through
 * the same `catch`, so the two plans execute identical code. That is not a
 * redundancy to delete — it is the model/implementation divergence
 * `collapsedPlans` exists to surface, and the test asserts it appears.
 *
 * `/api/profile/rev` is deliberately outside the rule's regex: every GET of
 * `/api/profile` moves the revision on, so a state probe that used it would
 * change the thing it measures and be counted as a revalidation besides.
 */
export default {
  rules: {
    profile: { urlPattern: /\/api\/profile(\?|$)/, methods: ["GET"] },
  },

  action: async (page) => {
    await page.getByRole("button", { name: "Refresh profile" }).click();
  },

  uiProbe: async (page) => {
    const state = await page.locator("#app").getAttribute("data-state");
    // "idle" at the probe means the page-load read never resolved — not a
    // state this contract allows, and not one to confuse with "stale".
    return state === "idle" ? "stuck" : (state ?? "unknown");
  },

  stateProbe: async (page) =>
    page.evaluate(() => ({
      shown: Number(document.getElementById("profile").dataset.rev),
    })),

  coverageFingerprints: true,

  /** One cached render plus one revalidation round trip, no backoff. */
  settleMs: 600,
};
