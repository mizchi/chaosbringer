import { describe, expect, it } from "vitest";
import {
  checkTiming,
  formatTimingCheck,
  solveTiming,
  timingLadder,
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
    expect(r.pageTimeoutMs).toBe(5936); // 696 + 5097 + 118 + 25
    expect(r.wallClockMs).toBe(5793); // fixed + settle
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

  it("rejects the value that empirically flaked (590ms under a 600ms deadline)", () => {
    // Measured: 13 ok / 2 error unthrottled, 11 ok / 4 error at 4x CPU throttle.
    const check = checkTiming(MEASURED, { deadlineMs: 600 }, { fastMs: 590 });
    expect(check.ok).toBe(false);
    expect(check.violations[0]!.constraint).toBe("fast_tolerated");
    // …while the solved 457ms held 15/15 in both conditions.
    expect(checkTiming(MEASURED, { deadlineMs: 600 }, { fastMs: 457 }).ok).toBe(true);
  });

  it("skips constraints whose inputs were not proposed", () => {
    const check = checkTiming(MEASURED, { deadlineMs: 5000 }, {});
    expect(check.rows).toEqual([]);
    expect(check.ok).toBe(true);
  });
});

describe("timingLadder", () => {
  it("spaces rungs by the measured separation, geometrically where it can", () => {
    const ladder = timingLadder(MEASURED, { loMs: 20, hiMs: 15000, budgetMs: 60000 });
    expect(ladder.separationMs).toBe(139); // 118 - 4 + 25
    expect(ladder.rungs[0]).toBe(20);
    for (let i = 1; i < ladder.rungs.length; i++) {
      expect(ladder.rungs[i]! - ladder.rungs[i - 1]!).toBeGreaterThanOrEqual(ladder.separationMs);
    }
    expect(ladder.estimatedTotalMs).toBeLessThanOrEqual(60000);
  });

  it("is bounded by the clock, not the arithmetic", () => {
    const ladder = timingLadder(MEASURED, { loMs: 20, hiMs: 15000, budgetMs: 5000 });
    expect(ladder.truncatedBy).toBe("budget");
    // A 15s rung alone costs 15s, so a small budget stops well short of hi.
    expect(Math.max(...ladder.rungs)).toBeLessThan(15000);
  });

  it("covers the range when the budget allows", () => {
    const ladder = timingLadder(MEASURED, { loMs: 20, hiMs: 2000, budgetMs: 600000 });
    expect(ladder.truncatedBy).toBe("range");
    expect(Math.max(...ladder.rungs)).toBeLessThanOrEqual(2000);
  });
});
