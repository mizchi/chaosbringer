/**
 * Bridge for the timeout pattern.
 *
 * The only pattern where the plans carry no millisecond values at all: their
 * `slow-ok` / `slow-trip` outcomes are resolved here, from `appDeadlineMs` plus
 * the machine's measured profile. On this container that means a ~553ms delay
 * for "slow but tolerable" and ~731ms for "too slow"; on a slower runner the
 * same plans get different numbers, which is the point.
 */
import { readFileSync } from "node:fs";

const timingProfile = JSON.parse(
  readFileSync(new URL("../../model/profile.json", import.meta.url), "utf8"),
);

export default {
  rules: {
    report: { urlPattern: /\/api\/report$/, methods: ["GET"] },
  },

  /** Must match DEADLINE_MS in public/slow.js — the test asserts it does. */
  appDeadlineMs: 700,
  timingProfile,

  action: async (page) => {
    await page.getByRole("button", { name: "Load report" }).click();
  },

  uiProbe: async (page) => {
    const state = await page.locator("#app").getAttribute("data-state");
    // Still loading when the probe fires is what the model calls stuck — and
    // the probe fires after the app's own deadline should have resolved, so
    // this is a real verdict rather than an impatient one.
    return state === "loading" ? "stuck" : (state ?? "unknown");
  },

  // No settleMs: solved from appDeadlineMs + timingProfile.
};
