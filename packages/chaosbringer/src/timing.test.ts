import { describe, expect, it } from "vitest";
import {
  checkTiming,
  formatTimingCheck,
  ladderSettleMs,
  solveTiming,
  DEFAULT_TIMING_PROFILE,
  type TimingProfile,
} from "./timing.js";

/**
 * The envelope measured on this repo's dev container over three calibration
 * runs (`chaosbringer model calibrate`). Used as the fixture because the
 * expected values below were cross-checked against a z3 optimum over 192
 * parameter combinations — see
 * docs/superpowers/specs/2026-08-20-timing-solver/verify-closed-form.py.
 */
const MEASURED: TimingProfile = {
  delayFloorMs: 4,
  delayTailMs: 59,
  tightTailMs: 36,
  fixedPerPlanMs: 696,
  runs: 3,
};

describe("solveTiming", () => {
  it("solves the case that actually bit us: a 5000ms app deadline", () => {
    const r = solveTiming(MEASURED, { deadlineMs: 5000 });
    expect(r.status).toBe("sat");
    if (r.status !== "sat") return;
    // safety 2 => delayTail 118, tightTail 72; margin 25.
    expect(r.settleMs).toBe(5097); // 5000 + 72 + 25
    expect(r.fastMs).toBe(4857); // 5000 - 118 - 25
    expect(r.slowMs).toBe(5118); // settle 5097 + margin 25 - floor 4
    expect(r.releaseMs).toBe(5122); // settle + margin
    // The navigation timeout has to survive the slowest delay a plan can put
    // on a load-time request, which is `slow` — not the probe window, which
    // `timeout` does not bound at all.
    expect(r.pageTimeoutMs).toBe(5957); // fixed 696 + slow 5118 + tail 118 + margin 25
    // …and the wall clock includes the observation window, because a run
    // spends it. Omitting it under-reported this plan by 5097ms — the number
    // `model calibrate` prints for sizing a suite.
    expect(r.wallClockMs).toBe(10890); // fixed 696 + settle 5097 + quiesce 5097
    expect(r.wallClockMs).toBe(r.profile.fixedPerPlanMs + r.settleMs + r.quiescenceMs);
  });

  it("refuses inputs that are not numbers instead of solving them into NaN", () => {
    // `Number(process.env.APP_DEADLINE)` on an unset variable. Every
    // comparison against NaN is false, so without an explicit check this
    // answered `sat` with settleMs/fastMs/slowMs all NaN — which reaches the
    // browser as `page.waitForTimeout(NaN)` and `{ kind: "delay", ms: NaN }`.
    for (const bad of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      const r = solveTiming(MEASURED, { deadlineMs: bad });
      expect(r.status, `deadlineMs=${bad}`).toBe("unsat");
      if (r.status !== "unsat") continue;
      expect(r.core).toEqual(["inputs_well_formed"]);
      expect(r.explanation).toMatch(/deadlineMs must be/);
    }
    // The same machinery for the other numeric inputs, so none of them can
    // sneak a NaN into the closed form either.
    expect(solveTiming(MEASURED, { deadlineMs: 5000, budgetMs: Number.NaN }).status).toBe("unsat");
    expect(solveTiming(MEASURED, { deadlineMs: 5000, safety: Number.NaN }).status).toBe("unsat");
    expect(solveTiming(MEASURED, { deadlineMs: 5000, marginMs: Number.NaN }).status).toBe("unsat");
    expect(
      solveTiming({ ...MEASURED, tightTailMs: Number.NaN }, { deadlineMs: 5000 }).status,
    ).toBe("unsat");
    // And a sat answer never carries one.
    const ok = solveTiming(MEASURED, { deadlineMs: 5000 });
    if (ok.status !== "sat") throw new Error("sat expected");
    for (const [k, v] of Object.entries(ok)) {
      if (typeof v === "number") expect(Number.isFinite(v), k).toBe(true);
    }
  });

  it("derives the post-probe observation window the same way as the probe", () => {
    const r = solveTiming(MEASURED, { deadlineMs: 5000 });
    if (r.status !== "sat") throw new Error("sat expected");
    // One more app-bounded round: the retry an error path schedules, or the
    // commit a 202-Accepted backend does after answering, is bounded by the
    // same deadline as the call that provoked it.
    expect(r.quiescenceMs).toBe(5097); // 5000 + 72 + 25
    expect(r.quiescenceMs).toBe(r.settleMs);
  });

  it("reports infeasible when the deadline is inside the environment's own jitter", () => {
    const r = solveTiming(MEASURED, { deadlineMs: 120 });
    expect(r.status).toBe("unsat");
    if (r.status !== "unsat") return;
    expect(r.core).toContain("fast_tolerated");
    expect(r.core).toContain("expressible");
    // The explanation has to name the number to raise the deadline above.
    expect(r.explanation).toMatch(/147ms/);
    expect(r.explanation).toMatch(/jitter is 118ms/);
  });

  it("reports infeasible when the budget cannot fit one plan", () => {
    const r = solveTiming(MEASURED, { deadlineMs: 5000, budgetMs: 3000 });
    expect(r.status).toBe("unsat");
    if (r.status !== "unsat") return;
    expect(r.core).toContain("within_budget");
    expect(r.explanation).toMatch(/budget is too small/);
    // The budget is measured against the wall clock the plan really spends,
    // so the explanation quotes that number and not the navigation timeout.
    expect(r.explanation).toMatch(/one plan costs ~10890ms/);
    // …and a budget between the two used to pass: 5957 fits, 10890 does not.
    expect(solveTiming(MEASURED, { deadlineMs: 5000, budgetMs: 8000 }).status).toBe("unsat");
    expect(solveTiming(MEASURED, { deadlineMs: 5000, budgetMs: 11000 }).status).toBe("sat");
  });

  it("a trustworthy calibration buys a tighter solution via safety", () => {
    const loose = solveTiming(MEASURED, { deadlineMs: 1000 });
    const tight = solveTiming(MEASURED, { deadlineMs: 1000, safety: 1 });
    if (loose.status !== "sat" || tight.status !== "sat") throw new Error("both should be sat");
    expect(tight.settleMs).toBeLessThan(loose.settleMs);
    // …and a more forgiving tolerated delay, because less tail is assumed.
    expect(tight.fastMs).toBeGreaterThan(loose.fastMs);
  });

  it("the default profile is pessimistic enough to refuse sub-300ms deadlines", () => {
    expect(solveTiming(DEFAULT_TIMING_PROFILE, { deadlineMs: 250 }).status).toBe("unsat");
    expect(solveTiming(DEFAULT_TIMING_PROFILE, { deadlineMs: 1000 }).status).toBe("sat");
  });

  it("scales the jitter tails but never the floor or the fixed cost", () => {
    const r = solveTiming(MEASURED, { deadlineMs: 5000, safety: 3 });
    if (r.status !== "sat") throw new Error("sat expected");
    expect(r.profile.delayTailMs).toBe(177); // 59 * 3
    expect(r.profile.tightTailMs).toBe(108); // 36 * 3
    expect(r.profile.delayFloorMs).toBe(4); // as measured
    expect(r.profile.fixedPerPlanMs).toBe(696); // as measured
  });
});

describe("checkTiming", () => {
  it("catches the real misconfiguration: settleMs 1200 against a 5000ms deadline", () => {
    const check = checkTiming(MEASURED, { deadlineMs: 5000 }, { settleMs: 1200 });
    expect(check.ok).toBe(false);
    const probe = check.violations.find((v) => v.constraint === "probe_after_deadline")!;
    expect(probe.slackMs).toBe(-3897); // 1200 - (5000 + 72 + 25)
    expect(formatTimingCheck(check)).toMatch(/FAIL probe_after_deadline/);
  });

  it("passes the solved values it was derived from", () => {
    const solved = solveTiming(MEASURED, { deadlineMs: 5000 });
    if (solved.status !== "sat") throw new Error("sat expected");
    const check = checkTiming(
      MEASURED,
      { deadlineMs: 5000 },
      {
        settleMs: solved.settleMs,
        fastMs: solved.fastMs,
        slowMs: solved.slowMs,
        releaseMs: solved.releaseMs,
        pageTimeoutMs: solved.pageTimeoutMs,
      },
    );
    expect(check.ok).toBe(true);
    // Solved values sit exactly on the boundary — that is what "tightest" means.
    expect(check.rows.every((r) => r.slackMs >= 0)).toBe(true);
    expect(check.rows.some((r) => r.slackMs === 0)).toBe(true);
  });

  it("requires the tripping delay to outlast the probe, not just the deadline", () => {
    // 5093ms misses a 5000ms deadline, so a bounded app fails as intended —
    // but an UNBOUNDED app answers at ~5093ms, before the 5097ms probe, and
    // reads as ready. That is precisely the app a timing plan is hunting.
    const check = checkTiming(MEASURED, { deadlineMs: 5000 }, { slowMs: 5093, settleMs: 5097 });
    expect(check.rows.find((r) => r.constraint === "slow_trips")!.slackMs).toBeGreaterThanOrEqual(0);
    const outlasts = check.violations.find((r) => r.constraint === "slow_outlasts_probe")!;
    expect(outlasts.slackMs).toBe(-25);
    // The solved value satisfies both.
    expect(
      checkTiming(MEASURED, { deadlineMs: 5000 }, { slowMs: 5118, settleMs: 5097 }).ok,
    ).toBe(true);
  });

  it("catches an observation window too short to see the app's own follow-up", () => {
    // The shape hole F had: a `void retry()` scheduled 900ms after the action,
    // watched for 400ms. The window is not a guess to be trusted either.
    const check = checkTiming(MEASURED, { deadlineMs: 900 }, { settleMs: 1000, quiescenceMs: 400 });
    expect(check.ok).toBe(false);
    const row = check.violations.find(
      (v) => v.constraint === "rejections_drained_after_last_timer",
    )!;
    expect(row.slackMs).toBe(-597); // 400 - (900 + 72 + 25)
    expect(row.detail).toMatch(/settles after the run ended/);
    // …and the solved value satisfies it exactly.
    const solved = solveTiming(MEASURED, { deadlineMs: 900 });
    if (solved.status !== "sat") throw new Error("sat expected");
    expect(
      checkTiming(
        MEASURED,
        { deadlineMs: 900 },
        { settleMs: solved.settleMs, quiescenceMs: solved.quiescenceMs },
      ).ok,
    ).toBe(true);
  });

  it("catches a window solved for one request against an app that retries", () => {
    // F7: reconnect-budget declares appDeadlineMs 500 and its contract is a
    // ladder of three of them plus [60, 120] of backoff. The solved 597ms
    // window ends before the client has made its third attempt, so a correct,
    // budgeted client is reported as an endless spinner.
    const ladder = { attempts: 3, backoffsMs: [60, 120] };
    const solved = solveTiming(MEASURED, { deadlineMs: 500 });
    if (solved.status !== "sat") throw new Error("sat expected");
    const check = checkTiming(
      MEASURED,
      { deadlineMs: 500, ladder },
      { settleMs: solved.settleMs },
    );
    expect(check.ok).toBe(false);
    const row = check.violations.find((v) => v.constraint === "settle_outlasts_app_ladder")!;
    // 3 x (500 + 72 + 25) + 180 = 1971, against the 597 solved for one round.
    expect(row.slackMs).toBe(solved.settleMs - 1971);
    expect(row.detail).toMatch(/climbing its own retry ladder/);
    expect(ladderSettleMs(ladder, 500, 72, 25)).toBe(1971);
    // …and a declared window past the ladder satisfies it.
    expect(checkTiming(MEASURED, { deadlineMs: 500, ladder }, { settleMs: 2000 }).ok).toBe(true);
    // With one attempt and no backoff the ladder *is* the one-round window,
    // so the new constraint cannot contradict the old one.
    expect(ladderSettleMs({ attempts: 1, backoffsMs: [] }, 500, 72, 25)).toBe(solved.settleMs);
  });

  it("rejects the value that empirically flaked (590ms under a 600ms deadline)", () => {
    // Measured: 13 ok / 2 error unthrottled, 11 ok / 4 error at 4x CPU throttle.
    const check = checkTiming(MEASURED, { deadlineMs: 600 }, { fastMs: 590 });
    expect(check.ok).toBe(false);
    expect(check.violations[0]!.constraint).toBe("fast_tolerated");
    // …while the solved 457ms held 15/15 in both conditions.
    expect(checkTiming(MEASURED, { deadlineMs: 600 }, { fastMs: 457 }).ok).toBe(true);
  });

  it("catches a hang released before the probe, which makes stuck unobservable", () => {
    // `stuck_observable` is the constraint that makes `hang` mean anything: a
    // route released at 5000ms against a probe at 5097ms hands the app its
    // answer *before* the oracle looks, so a client with no timeout at all
    // reads exactly like one that handled the failure. Asserted in the
    // violated direction, because the passing direction is satisfied by the
    // solved values whatever the arithmetic says.
    const check = checkTiming(MEASURED, { deadlineMs: 5000 }, { settleMs: 5097, releaseMs: 5000 });
    expect(check.ok).toBe(false);
    const row = check.violations.find((v) => v.constraint === "stuck_observable")!;
    expect(row.slackMs).toBe(-122); // 5000 - (5097 + 25)
    expect(row.detail).toMatch(/releaseMs=5000 must be >= settleMs 5097 \+ margin 25/);
    // Exactly on the boundary passes; one ms under does not.
    expect(
      checkTiming(MEASURED, { deadlineMs: 5000 }, { settleMs: 5097, releaseMs: 5122 }).ok,
    ).toBe(true);
    expect(
      checkTiming(MEASURED, { deadlineMs: 5000 }, { settleMs: 5097, releaseMs: 5121 }).ok,
    ).toBe(false);
  });

  it("checks a declared page timeout against navigation, which is all it bounds", () => {
    // The crawler's `timeout` reaches `page.goto(..., { waitUntil:
    // "networkidle" })` and nothing else, so what can blow it is a delayed
    // request issued *during* load — not the probe, which runs inside an
    // unbounded invariant.
    const tight = checkTiming(
      MEASURED,
      { deadlineMs: 5000 },
      { pageTimeoutMs: 3000, slowMs: 5118 },
    );
    expect(tight.ok).toBe(false);
    const row = tight.violations.find((v) => v.constraint === "fits_navigation_timeout")!;
    expect(row.slackMs).toBe(-2957); // 3000 - (696 + 5118 + 118 + 25)
    expect(
      checkTiming(MEASURED, { deadlineMs: 5000 }, { pageTimeoutMs: 5957, slowMs: 5118 }).ok,
    ).toBe(true);
  });

  it("checks a declared budget against both windows, not just the probe", () => {
    // The regression this pair exists for: a budget compared against a number
    // that omitted the observation window said `ok` about a plan that spends
    // it. 6000 covers fixed + settle (5793) and not fixed + settle + quiesce.
    const optimistic = checkTiming(
      MEASURED,
      { deadlineMs: 5000, budgetMs: 6000 },
      { settleMs: 5097, quiescenceMs: 5097 },
    );
    expect(optimistic.ok).toBe(false);
    const row = optimistic.violations.find((v) => v.constraint === "within_budget")!;
    expect(row.slackMs).toBe(-4890); // 6000 - (696 + 5097 + 5097)
    expect(row.detail).toMatch(/= 10890/);
    // …and a budget that admits both windows passes. (`quiescenceMs: 0` is the
    // other way out, but it is an opt-out `resolvePlanTiming` honours, not a
    // value this constraint set considers legal — a 0 window fails
    // `rejections_drained_after_last_timer` on purpose.)
    expect(
      checkTiming(
        MEASURED,
        { deadlineMs: 5000, budgetMs: 11000 },
        { settleMs: 5097, quiescenceMs: 5097 },
      ).ok,
    ).toBe(true);
  });

  it("skips constraints whose inputs were not proposed", () => {
    const check = checkTiming(MEASURED, { deadlineMs: 5000 }, {});
    expect(check.rows).toEqual([]);
    expect(check.ok).toBe(true);
  });
});
