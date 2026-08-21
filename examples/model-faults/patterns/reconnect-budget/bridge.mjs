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
import { ladderSettleMs } from "chaosbringer";

const timingProfile = JSON.parse(
  readFileSync(new URL("../../model/profile.json", import.meta.url), "utf8"),
);

const appDeadlineMs = 500;
const appLadder = { attempts: 3, backoffsMs: [60, 120] };
/**
 * The window, derived rather than typed in.
 *
 * `settleMs` used to be the literal 1800, next to a comment saying "1773 is the
 * minimum". Both numbers are functions of the machine's profile — one round is
 * `deadline + tightTail x safety + margin` — so an honest re-calibration moved
 * the minimum to 2067 and the literal became a pre-flight failure
 * (`settle_outlasts_app_ladder`, short by 267ms) rather than a stale comment.
 * `ladderSettleMs` is the runner's own function for it, so the declaration and
 * the constraint that validates it cannot disagree. The margin on top is one
 * solver margin, not one more round: the ladder is what has to fit.
 */
const marginMs = 25;
const settleMs =
  ladderSettleMs(appLadder, appDeadlineMs, timingProfile.tightTailMs * 2, marginMs) + marginMs;

export default {
  rules: {
    // `(\?|$)`, not `$`. Under `expect.calls` the regex is not a selector, it
    // is the definition of the number being asserted: a resumable stream
    // carries a cursor (`/api/stream?cursor=…`, `Last-Event-ID`), and an
    // anchored pattern neither faults nor counts those — 58 requests would be
    // reported as the 9 the model predicted. The runner refuses the anchored
    // form here for exactly that reason.
    stream: { urlPattern: /\/api\/stream(\?|$)/, methods: ["GET"] },
  },

  /** Must match DEADLINE_MS in public/stream.js — the test asserts it does. */
  appDeadlineMs,
  /**
   * …and the ladder that deadline is climbed with, from the same file. This
   * pattern's terminal state is MAX_ATTEMPTS rounds away, not one: 3 rounds
   * plus BACKOFF_MS [60, 120]. The window solved from the deadline alone is
   * one round, which is enough only because every enumerated failure is
   * an instantaneous client-side reject — the moment the ladder grows a rung
   * that costs the app its own timeout (a dropped stream, which is the failure
   * this pattern is named for), that window ends before the client has made
   * its third attempt and reports a correct client as an endless spinner.
   */
  appLadder,
  timingProfile,

  action: async (page) => {
    await page.getByRole("button", { name: "Connect" }).click();
  },

  uiProbe: async (page) => {
    const state = await page.locator("#app").getAttribute("data-state");
    // Still connecting when the probe fires means the budget outlived the
    // whole ladder the app declares (see appLadder) — a spinner with no end,
    // rather than a client that has not finished its second attempt yet.
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

  /**
   * Declared *alongside* appDeadlineMs, which is what appLadder is for: the
   * solved delays for `slow-ok` / `slow-trip` still come from the profile,
   * while the probe waits out the whole ladder. Validated against it
   * (`settle_outlasts_app_ladder`) rather than trusted, and derived above from
   * the same numbers that validate it.
   */
  settleMs,
};
