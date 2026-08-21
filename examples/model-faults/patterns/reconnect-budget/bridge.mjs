/**
 * Bridge for the reconnect-budget pattern.
 *
 * The only bridge with no `stateProbe`, because there is no state to read. A
 * client with a reconnect budget and one without render the same spinner and
 * then the same connection; what separates them is how many requests they were
 * willing to make, and no page can report that about itself. `expect.calls` is
 * compared against what the fault layers counted instead.
 */
import { readFileSync } from "node:fs";

const timingProfile = JSON.parse(
  readFileSync(new URL("../../model/profile.json", import.meta.url), "utf8"),
);

export default {
  rules: {
    stream: { urlPattern: /\/api\/stream$/, methods: ["GET"] },
  },

  /** Must match DEADLINE_MS in public/stream.js — the test asserts it does. */
  appDeadlineMs: 500,
  timingProfile,

  action: async (page) => {
    await page.getByRole("button", { name: "Connect" }).click();
  },

  uiProbe: async (page) => {
    const state = await page.locator("#app").getAttribute("data-state");
    // Still connecting when the probe fires means the budget outlived the
    // window the app's own deadline implies — a spinner with no end.
    return state === "connecting" ? "stuck" : (state ?? "unknown");
  },

  uiInvariants: {
    // Both terminal labels owe the user a sentence about what happened. An
    // empty banner under "offline" is the outage nobody reported.
    "*": async (page) =>
      page.evaluate(() =>
        document.getElementById("banner").textContent.trim() === ""
          ? "the banner is empty, so the page reports its state to nobody"
          : "",
      ),
  },

  // No settleMs: solved from appDeadlineMs + timingProfile. Three attempts and
  // two backoffs (60ms + 120ms) finish well inside it.
};
