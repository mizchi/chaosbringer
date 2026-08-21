/**
 * Timing values this environment can actually keep.
 *
 * The fault layers can express a delay, and the runner can wait before it
 * probes — but whether a given pair of numbers *decides* anything depends on
 * the machine: the injection mechanism has a floor (nothing below it is
 * expressible) and a tail (jitter that can push an observation past a
 * deadline). Hand-picking constants against that is how you get a suite that
 * passes warm and flakes in CI. It is also how this repo shipped a
 * `settleMs` of 1200ms against an app deadline of 5000ms and got a
 * false "stuck" verdict.
 *
 * So the values are *solved* instead, against a measured profile:
 *
 *   settle  = deadline + tightTail + margin     probe after the app's bound resolves
 *   quiesce = deadline + tightTail + margin     keep watching one round longer
 *   fast    = deadline − delayTail − margin     a delay the app must still tolerate
 *   slow    = deadline + tightTail + margin − floor   a delay that must trip it
 *   release = settle + margin                   a hang outlasts the probe
 *   ladder  = attempts × (deadline + tightTail + margin) + Σ backoffs
 *                                               a declared window must outlast
 *                                               the app's whole retry ladder
 *   nav     = fixed + slow + delayTail + margin  navigation outlasts the
 *                                               slowest delay a plan can
 *                                               inject during load
 *   wall    = fixed + settle + quiesce           what one plan really costs
 *
 * That system is difference logic, so it has a closed form — no solver at
 * runtime, the same way plans need no Quint at runtime. The closed form was
 * checked against a z3 optimum over 192 parameter combinations, including 66
 * infeasible ones; see
 * `docs/superpowers/specs/2026-08-20-timing-solver/verify-closed-form.py`.
 *
 * `wall` and `nav` changed when the post-probe observation window was
 * introduced: a run spends `settle` **and then** `quiesce`, so a `wall` that
 * omitted the second one under-reported every plan by an app deadline
 * (measured: 6725ms claimed against ~11950ms real at a 5000ms deadline) and
 * `budgetMs` — documented as the wall clock the operator will tolerate — was
 * being compared against something else entirely. The verification fixtures
 * are checks on this arithmetic, so they move with it; keeping a stale closed
 * form to keep an artifact green is how the arithmetic stops being auditable.
 *
 * Measure the profile with `chaosbringer model calibrate`. Until then
 * `DEFAULT_TIMING_PROFILE` is deliberately pessimistic.
 */

/** What the environment costs, in ms. Produced by `chaosbringer model calibrate`. */
export interface TimingProfile {
  /**
   * Minimum the injection mechanism adds. Nothing below this is expressible:
   * asking for a 1ms delay gets you `delayFloorMs`.
   */
  delayFloorMs: number;
  /**
   * Worst additive jitter measured on the *delay* path (route interception +
   * setTimeout + fallback), across calibration runs. This is the number a
   * single warm run under-reports, which is why `safety` scales it.
   */
  delayTailMs: number;
  /**
   * Worst additive jitter on the tight paths — `AbortSignal` firing and the
   * settle window. Measured separately because they are an order of
   * magnitude more accurate than the delay path, and pretending otherwise
   * costs real wall clock on every plan.
   */
  tightTailMs: number;
  /** Fixed per-plan cost: browser launch + page load + teardown. */
  fixedPerPlanMs: number;
  /** How many calibration runs the envelope came from. */
  runs?: number;
  /** ISO timestamp, for spotting a profile measured on different hardware. */
  measuredAt?: string;
  env?: { node?: string; platform?: string };
}

/**
 * Pessimistic stand-in for an unmeasured environment.
 *
 * Chosen as roughly 2× the envelope measured on a warm container (floor 4ms,
 * delay tail 59ms, tight tail 36ms, fixed 696ms) because the cold run of that
 * same calibration measured a 107ms delay tail. Safe, and wasteful — measure
 * your own.
 */
export const DEFAULT_TIMING_PROFILE: TimingProfile = {
  delayFloorMs: 10,
  delayTailMs: 250,
  tightTailMs: 100,
  fixedPerPlanMs: 1500,
};

export type TimingConstraint =
  /**
   * The request and the profile are made of usable numbers.
   *
   * `deadlineMs: Number(process.env.APP_DEADLINE)` with the variable unset is
   * `NaN`, and `NaN` propagates through every comparison as `false` — so
   * without this the solver answered `sat` with every field `NaN`, which
   * reaches the browser as `page.waitForTimeout(NaN)` and
   * `{ kind: "delay", ms: NaN }`. Infeasible is a first-class answer here, so
   * an unusable input gets the same answer as an impossible one.
   */
  | "inputs_well_formed"
  /** Every value is at or above the mechanism's floor. */
  | "expressible"
  /** A "slow but acceptable" delay lands before the app's bound, worst tail included. */
  | "fast_tolerated"
  /** A "too slow" delay misses the bound, best case included. */
  | "slow_trips"
  /**
   * A "too slow" delay also outlasts the probe.
   *
   * Missing the app's bound is not enough to be *observable*: against an app
   * with no bound at all — the very thing a timing plan is trying to detect —
   * the response still arrives, and if it lands before the probe the page
   * reads as "ready" instead of "stuck". So the tripping delay has to survive
   * the settle window too.
   */
  | "slow_outlasts_probe"
  /** The probe fires after the app's own bound has resolved. */
  | "probe_after_deadline"
  /** A hung request outlasts the probe, so "stuck" is observable. */
  | "stuck_observable"
  /**
   * The probe fires after the app's whole retry *ladder* has run, not merely
   * after one bounded request.
   *
   * `probe_after_deadline` bounds one round. An app that retries a dropped
   * request three times with backoffs between them reaches its terminal state
   * three rounds later, and a window solved for one of them reports a
   * correctly budgeted client as an endless spinner — three false mismatches
   * against an app that is doing exactly what its contract says. Only checked
   * when a bridge declares `appLadder`, because only the bridge author knows
   * how many rungs their client climbs.
   */
  | "settle_outlasts_app_ladder"
  /**
   * The observation window after the probe is long enough for one more
   * app-bounded round of work to run and be drained.
   *
   * The probe is an instant, and an instant cannot decide "no rejection
   * escaped" or "the write happened exactly once": a retry scheduled on the
   * error path, or a backend that acknowledges now and commits later, lands
   * *after* it. So the runner keeps watching for `quiescenceMs` and reads the
   * state observables a second time. One app deadline plus the tight tail is
   * the unit — it is how long one more bounded operation can take here.
   *
   * This bounds one further round, not an arbitrarily deep retry chain; see
   * the recipe's "What the oracle still cannot see".
   */
  | "rejections_drained_after_last_timer"
  /**
   * A declared page timeout outlasts the slowest delay a plan can inject
   * while the page is still navigating.
   *
   * Named for what the option actually bounds. The crawler's `timeout` reaches
   * `page.goto(url, { waitUntil: "networkidle" })` and the recovery
   * navigation, and nothing else — `runInvariants`, where the action, the
   * settle window, the probe and the observation window all live, is
   * unbounded. So this is not "does the run fit its timeout" (it cannot fail
   * that way); it is "can the page finish loading while a `slow-trip` delay
   * is being injected into a load-time request". Only checked against a
   * *declared* `pageTimeoutMs`, since the solved one satisfies it by
   * construction.
   */
  | "fits_navigation_timeout"
  /** The plan's real wall clock — settle *and* observation window — fits the operator's budget. */
  | "within_budget";

/**
 * The app's own retry ladder: how many bounded attempts it makes before it
 * gives up, and how long it waits between them.
 *
 * `deadlineMs` describes one request. A client that retries has a *terminal*
 * state that is several requests away, and the probe has to outlast the whole
 * climb — `settleMs` solved for one round reports a correct client as stuck.
 * Only the bridge author knows the ladder, so it is declared rather than
 * derived.
 */
export interface AppLadder {
  /** Bounded attempts, including the first. `1` means no retry ladder. */
  attempts: number;
  /** Waits between attempts, in ms. At most `attempts - 1` of them. */
  backoffsMs: readonly number[];
}

/**
 * Worst-case wall clock of the app's own ladder, tails and margins included.
 *
 * Enforces the shape `AppLadder` documents — `attempts` a positive integer,
 * at most `attempts - 1` backoffs, all of them non-negative — because it is
 * exported and reachable without going through `resolvePlanTiming`, which is
 * where those checks used to live exclusively. Unvalidated,
 * `{ attempts: 1, backoffsMs: [9999] }` returned 15224ms for a window whose
 * real answer is 5225ms, and a caller comparing a declared `settleMs` against
 * that number is being told to wait ten seconds for a ladder that has no
 * rungs.
 */
export function ladderSettleMs(
  ladder: AppLadder,
  deadline: number,
  tightTailMs: number,
  marginMs: number,
): number {
  if (!Number.isInteger(ladder.attempts) || ladder.attempts < 1) {
    throw new Error(
      `chaosbringer: appLadder.attempts must be a positive integer, got ` +
        `${JSON.stringify(ladder.attempts)} — it counts bounded attempts including the first`,
    );
  }
  if (ladder.backoffsMs.length > ladder.attempts - 1) {
    throw new Error(
      `chaosbringer: appLadder declares ${ladder.attempts} attempt(s) but ` +
        `${ladder.backoffsMs.length} backoff(s); there are at most attempts-1 waits between them`,
    );
  }
  if (ladder.backoffsMs.some((b) => !Number.isFinite(b) || b < 0)) {
    throw new Error(
      `chaosbringer: appLadder.backoffsMs must all be finite and >= 0, got ` +
        `[${ladder.backoffsMs.join(", ")}]`,
    );
  }
  // One round is `deadline + tightTail + margin` — the same unit `settleMs`
  // already uses — and every rung pays its own tail, because every rung has
  // its own abort to observe. With `attempts: 1` and no backoffs this is
  // exactly the one-round window, so the ladder generalises the existing
  // arithmetic instead of competing with it.
  const perRound = deadline + tightTailMs + marginMs;
  const waiting = ladder.backoffsMs.reduce((a, b) => a + b, 0);
  return ladder.attempts * perRound + waiting;
}

export interface TimingRequest {
  /**
   * The app's own request bound — `AbortSignal.timeout(n)`, a `Promise.race`
   * deadline, a server-side timeout. Everything else is derived from it.
   */
  deadlineMs: number;
  /**
   * The app's retry ladder, when it has one. Used to validate a declared
   * `settleMs` against the terminal state the app actually reaches, never to
   * override it.
   */
  ladder?: AppLadder;
  /** Required slack on every separation. Default 25ms. */
  marginMs?: number;
  /**
   * Multiplier applied to the measured jitter. Default 2 — a single
   * calibration run measured a 14ms tail where a cold one measured 107ms, so
   * taking the envelope at face value is not conservative.
   */
  safety?: number;
  /**
   * Per-plan wall clock the operator will tolerate. Default 15000ms.
   *
   * Compared against `wallClockMs` — fixed cost + settle window + observation
   * window — which is what a plan actually spends. It used to be compared
   * against `pageTimeoutMs`, a number that omitted the observation window
   * entirely, so a `budgetMs` the run blew through by an app deadline still
   * solved `sat`.
   */
  budgetMs?: number;
}

/** The profile after `safety` has been applied — what the arithmetic actually used. */
export interface ResolvedProfile extends TimingProfile {
  safety: number;
  marginMs: number;
}

export interface TimingSolution {
  status: "sat";
  /** A delay the app must still tolerate (verdict: success). */
  fastMs: number;
  /** A delay guaranteed to trip the app's bound (verdict: error). */
  slowMs: number;
  /** How long to wait after the action before probing the UI. */
  settleMs: number;
  /**
   * How much longer to keep watching after the probe, before re-reading the
   * state observables. Same arithmetic as `settleMs`: one more app-bounded
   * round of work, tail included.
   */
  quiescenceMs: number;
  /**
   * When a hung request should be released, so that "stuck" is observable and
   * the route does not outlive the run.
   *
   * Nothing in the model pipeline consumes it: `runPlan` realises the `hang`
   * outcome client-side with `never-settle-fetch`, which has no release. This
   * is the number to pass as `faults.hang({ releaseAfterMs })` when you drive
   * the network layer yourself, and it is the value `checkTiming`'s
   * `stuck_observable` row validates.
   */
  releaseMs: number;
  /**
   * Navigation timeout the run needs — the crawler's `timeout` option.
   *
   * That option bounds `page.goto(url, { waitUntil: "networkidle" })` and the
   * recovery navigation, and nothing else: the action, the settle window, the
   * probe and the observation window run inside an unbounded invariant. So it
   * is sized to outlast the slowest delay a plan can inject into a *load-time*
   * request, not the whole run — `fixed + slow + delayTail + margin`.
   */
  pageTimeoutMs: number;
  /**
   * Per-plan wall clock, for budgeting a suite: `fixed + settle + quiesce`.
   *
   * Both windows, because a run spends both. `asyncDrainCapMs` can add on top,
   * bounded by the timers the page actually has due inside it.
   */
  wallClockMs: number;
  profile: ResolvedProfile;
}

export interface TimingInfeasible {
  status: "unsat";
  /** The constraints that conflict. */
  core: TimingConstraint[];
  /** What to change, in words. */
  explanation: string;
  profile: ResolvedProfile;
}

export type TimingResult = TimingSolution | TimingInfeasible;

function resolve(profile: TimingProfile, request: TimingRequest): ResolvedProfile {
  const safety = request.safety ?? 2;
  return {
    ...profile,
    // Floors and fixed costs are stable across runs and taken as measured;
    // only the jitter tails get the safety factor.
    delayTailMs: Math.ceil(profile.delayTailMs * safety),
    tightTailMs: Math.ceil(profile.tightTailMs * safety),
    safety,
    marginMs: request.marginMs ?? 25,
  };
}

/**
 * Navigation timeout a run needs, given the tripping delay it will inject.
 *
 * Exported so a caller who *declares* a settle window can re-derive it from
 * the window actually in use instead of the solved one. Not part of the
 * package's public surface — `solveTiming` and `resolvePlanTiming` are.
 */
export function navigationTimeoutMs(p: ResolvedProfile, slowMs: number): number {
  return p.fixedPerPlanMs + slowMs + p.delayTailMs + p.marginMs;
}

/** Per-plan wall clock: fixed cost, then the probe window, then the observation window. */
export function planWallClockMs(
  p: ResolvedProfile,
  settleMs: number,
  quiescenceMs: number,
): number {
  return p.fixedPerPlanMs + settleMs + quiescenceMs;
}

/**
 * Solve for the tightest values this environment can honour.
 *
 * "Tightest" means: the smallest probe window (wall clock is dominated by it),
 * the smallest tripping delay, and the most forgiving tolerated delay — in
 * that order. Infeasible is a first-class answer: a deadline smaller than the
 * environment's own jitter cannot be tested at all, and saying so beats
 * emitting numbers that flake.
 */
export function solveTiming(
  profile: TimingProfile,
  request: TimingRequest,
): TimingResult {
  const p = resolve(profile, request);
  const { delayFloorMs: floor, delayTailMs: tail, tightTailMs: tight, fixedPerPlanMs: fixed, marginMs: margin } = p;
  const deadline = request.deadlineMs;
  const budget = request.budgetMs ?? 15000;

  // Nothing below this point can be trusted with a number that is not one:
  // every comparison against `NaN` is `false`, so an unvalidated `NaN`
  // deadline walked out of here as `status: "sat"` with every field `NaN`.
  const malformed = malformedInputs(profile, request);
  if (malformed !== null) {
    return {
      status: "unsat",
      core: ["inputs_well_formed"],
      explanation: malformed,
      profile: p,
    };
  }

  const settleMs = deadline + tight + margin;
  // The post-probe observation window. Same unit as the settle window,
  // because it has the same job one round later: outlast whatever the app
  // scheduled in response to the outcomes the plan injected.
  const quiescenceMs = deadline + tight + margin;
  const fastMs = deadline - tail - margin;
  // Two requirements, and the second is the one that is easy to miss: the
  // tripping delay must miss the deadline (settle >= deadline + tight + margin
  // covers that) *and* outlast the probe, or an unbounded app answers
  // mid-probe and reads as healthy.
  const slowMs = settleMs + margin - floor;
  const releaseMs = settleMs + margin;
  // Navigation only: `timeout` reaches `page.goto` and nothing else. What can
  // legitimately stretch a `waitUntil: "networkidle"` load is a delay injected
  // into a request the page issues *during* load, and the largest one a plan
  // can carry is `slow`.
  const pageTimeoutMs = navigationTimeoutMs(p, slowMs);
  // Both windows: a plan waits `settle`, probes, then waits `quiesce` and
  // reads again.
  const wallClockMs = planWallClockMs(p, settleMs, quiescenceMs);

  const core: TimingConstraint[] = [];
  if (fastMs < floor) core.push("expressible", "fast_tolerated");
  if (slowMs < floor) core.push("expressible", "slow_trips");
  if (wallClockMs > budget) core.push("within_budget");

  // slowMs is derived from settleMs, so this cannot fail — which makes it an
  // assertion, not a constraint. Pushing it into `core` instead left a branch
  // `explain()` has no words for and a "violation" no caller could act on; a
  // throw means a future edit to the closed form fails loudly here rather than
  // shipping an unexplainable unsat.
  if (slowMs + floor < settleMs + margin) {
    throw new Error(
      `chaosbringer internal: solveTiming's closed form broke slow_outlasts_probe ` +
        `(slow ${slowMs} + floor ${floor} < settle ${settleMs} + margin ${margin}). ` +
        `The tripping delay must outlast the probe by construction.`,
    );
  }

  if (core.length > 0) {
    return {
      status: "unsat",
      core: [...new Set(core)],
      explanation: explain(core, deadline, budget, p, wallClockMs),
      profile: p,
    };
  }

  return {
    status: "sat",
    fastMs,
    slowMs,
    settleMs,
    quiescenceMs,
    releaseMs,
    pageTimeoutMs,
    wallClockMs,
    profile: p,
  };
}

/**
 * Why these inputs cannot be solved at all, or `null` when they can.
 *
 * Separate from the constraints because it is a different kind of "no": the
 * constraints say *this environment* cannot honour these values, this says the
 * values are not values. Both come back as `unsat`, because a caller who has
 * to handle one has to handle the other, and the alternative is a `sat`
 * carrying `NaN`.
 */
function malformedInputs(profile: TimingProfile, request: TimingRequest): string | null {
  const positive = (label: string, v: number | undefined): string | null => {
    if (v === undefined) return null;
    if (!Number.isFinite(v)) {
      // `String`, not `JSON.stringify`: the latter renders NaN as `null`, and
      // "got null" sends the reader looking for the wrong bug.
      return (
        `${label} must be a finite number, got ${String(v)}. ` +
        `\`Number(process.env.X)\` on an unset variable is NaN, and NaN compares false against ` +
        `every bound — so this would otherwise solve as a set of NaN delays and a NaN probe window.`
      );
    }
    if (v <= 0) {
      return `${label} must be greater than 0, got ${v} — there is no window to probe after.`;
    }
    return null;
  };
  const nonNegative = (label: string, v: number | undefined): string | null => {
    if (v === undefined) return null;
    if (!Number.isFinite(v)) return `${label} must be a finite number, got ${String(v)}.`;
    if (v < 0) return `${label} must be >= 0, got ${v}.`;
    return null;
  };
  return (
    positive("deadlineMs", request.deadlineMs) ??
    positive("budgetMs", request.budgetMs) ??
    positive("safety", request.safety) ??
    nonNegative("marginMs", request.marginMs) ??
    nonNegative("profile.delayFloorMs", profile.delayFloorMs) ??
    nonNegative("profile.delayTailMs", profile.delayTailMs) ??
    nonNegative("profile.tightTailMs", profile.tightTailMs) ??
    nonNegative("profile.fixedPerPlanMs", profile.fixedPerPlanMs)
  );
}

function explain(
  core: readonly TimingConstraint[],
  deadline: number,
  budget: number,
  p: ResolvedProfile,
  wallClockMs: number,
): string {
  if (core.includes("fast_tolerated")) {
    const smallest = p.delayFloorMs + p.delayTailMs;
    return (
      `no expressible delay is tolerable under a ${deadline}ms deadline: this environment's ` +
      `jitter is ${p.delayTailMs}ms (measured × safety ${p.safety}) and its floor is ` +
      `${p.delayFloorMs}ms, so even the smallest injectable delay can be observed at ` +
      `${smallest}ms. Raise the deadline above ${smallest + p.marginMs}ms, lower the safety ` +
      `factor if your calibration is trustworthy, or stop asserting on timing at this scale.`
    );
  }
  if (core.includes("within_budget")) {
    return (
      `a ${budget}ms budget is too small: one plan costs ~${wallClockMs}ms here — ` +
      `${p.fixedPerPlanMs}ms fixed overhead, plus a ${deadline + p.tightTailMs + p.marginMs}ms ` +
      `probe window that must outlast the app's ${deadline}ms deadline, plus the same again as ` +
      `the observation window that watches for the retry the app schedules on the error path. ` +
      `Raise the budget, shorten the app's own deadline, or set quiescenceMs: 0 on the bridge if ` +
      `you accept that a late rejection or a late commit will not be seen.`
    );
  }
  return `constraints ${core.join(", ")} cannot hold together at deadline ${deadline}ms`;
}

/** One row of `checkTiming`: does this constraint hold, and by how much? */
export interface TimingSlack {
  constraint: TimingConstraint;
  /** ms of headroom. Negative means violated. */
  slackMs: number;
  /** The arithmetic, for the error message. */
  detail: string;
}

export interface TimingCheck {
  ok: boolean;
  rows: TimingSlack[];
  violations: TimingSlack[];
  profile: ResolvedProfile;
}

/** A config to validate — anything omitted is skipped rather than assumed. */
export interface ProposedTiming {
  settleMs?: number;
  quiescenceMs?: number;
  fastMs?: number;
  slowMs?: number;
  releaseMs?: number;
  pageTimeoutMs?: number;
}

/**
 * Validate hand-written values and report the slack on every constraint.
 *
 * This is the pre-flight that turns "why did a correctly-bounded request get
 * reported as stuck?" into a message before the browser even launches.
 */
export function checkTiming(
  profile: TimingProfile,
  request: TimingRequest,
  proposed: ProposedTiming,
): TimingCheck {
  const p = resolve(profile, request);
  const { delayFloorMs: floor, delayTailMs: tail, tightTailMs: tight, fixedPerPlanMs: fixed, marginMs: margin } = p;
  const deadline = request.deadlineMs;
  const budget = request.budgetMs ?? 15000;
  const rows: TimingSlack[] = [];

  if (proposed.settleMs !== undefined) {
    const need = deadline + tight + margin;
    rows.push({
      constraint: "probe_after_deadline",
      slackMs: proposed.settleMs - need,
      detail: `settleMs=${proposed.settleMs} must be >= deadline ${deadline} + tightTail ${tight} + margin ${margin} = ${need}`,
    });
  }
  if (proposed.settleMs !== undefined && request.ladder !== undefined) {
    const ladder = request.ladder;
    const need = ladderSettleMs(ladder, deadline, tight, margin);
    rows.push({
      constraint: "settle_outlasts_app_ladder",
      slackMs: proposed.settleMs - need,
      detail:
        `settleMs=${proposed.settleMs} must be >= ${ladder.attempts} attempt(s) x (deadline ` +
        `${deadline} + tightTail ${tight} + margin ${margin}) + backoffs ` +
        `[${ladder.backoffsMs.join(", ")}] = ${need}, or the probe fires while the app is still ` +
        `climbing its own retry ladder and a correctly budgeted client reads as an endless spinner`,
    });
  }
  if (proposed.quiescenceMs !== undefined) {
    const need = deadline + tight + margin;
    rows.push({
      constraint: "rejections_drained_after_last_timer",
      slackMs: proposed.quiescenceMs - need,
      detail:
        `quiescenceMs=${proposed.quiescenceMs} must be >= deadline ${deadline} + tightTail ${tight} + ` +
        `margin ${margin} = ${need}, or a retry the app scheduled on the error path settles after the run ended`,
    });
  }
  if (proposed.fastMs !== undefined) {
    rows.push({
      constraint: "fast_tolerated",
      slackMs: deadline - margin - (proposed.fastMs + tail),
      detail: `fastMs=${proposed.fastMs} + delayTail ${tail} must be <= deadline ${deadline} - margin ${margin}`,
    });
  }
  if (proposed.slowMs !== undefined) {
    rows.push({
      constraint: "slow_trips",
      slackMs: proposed.slowMs + floor - (deadline + tight + margin),
      detail: `slowMs=${proposed.slowMs} + floor ${floor} must be >= deadline ${deadline} + tightTail ${tight} + margin ${margin}`,
    });
    // Against an unbounded app the response still arrives; if it lands before
    // the probe, "no deadline at all" is indistinguishable from "handled".
    const settle = proposed.settleMs ?? deadline + tight + margin;
    rows.push({
      constraint: "slow_outlasts_probe",
      slackMs: proposed.slowMs + floor - (settle + margin),
      detail: `slowMs=${proposed.slowMs} + floor ${floor} must be >= settleMs ${settle} + margin ${margin}, or an unbounded app answers mid-probe and reads as ready`,
    });
  }
  if (proposed.releaseMs !== undefined && proposed.settleMs !== undefined) {
    rows.push({
      constraint: "stuck_observable",
      slackMs: proposed.releaseMs - (proposed.settleMs + margin),
      detail: `releaseMs=${proposed.releaseMs} must be >= settleMs ${proposed.settleMs} + margin ${margin}`,
    });
  }
  // Only against a *declared* page timeout, and only against what that option
  // really bounds: `page.goto(..., { waitUntil: "networkidle" })`. A load-time
  // request carrying the tripping delay is the thing that can stretch a
  // navigation past it; the probe and the observation window cannot, because
  // they run inside an unbounded invariant.
  if (proposed.pageTimeoutMs !== undefined) {
    const slow = proposed.slowMs ?? deadline + tight + 2 * margin - floor;
    rows.push({
      constraint: "fits_navigation_timeout",
      slackMs: proposed.pageTimeoutMs - (fixed + slow + tail + margin),
      detail:
        `pageTimeoutMs=${proposed.pageTimeoutMs} must be >= fixed ${fixed} + slowMs ${slow} + ` +
        `delayTail ${tail} + margin ${margin}, or a page that issues the delayed request during ` +
        `load cannot finish navigating before the timeout fires`,
    });
  }
  // Only against a budget the caller actually stated. Applying the 15000ms
  // default here would turn "I declared a settle window" into "I accepted a
  // per-plan budget I never wrote down".
  if (proposed.settleMs !== undefined && request.budgetMs !== undefined) {
    const quiescence = proposed.quiescenceMs ?? deadline + tight + margin;
    rows.push({
      constraint: "within_budget",
      slackMs: budget - (fixed + proposed.settleMs + quiescence),
      detail:
        `budgetMs=${budget} must be >= fixed ${fixed} + settleMs ${proposed.settleMs} + ` +
        `quiescenceMs ${quiescence} = ${fixed + proposed.settleMs + quiescence}, which is what ` +
        `one plan spends: a run waits the settle window, probes, then waits the observation ` +
        `window and reads again`,
    });
  }

  const violations = rows.filter((r) => r.slackMs < 0);
  return { ok: violations.length === 0, rows, violations, profile: p };
}

/** Render a check as a one-screen report. */
export function formatTimingCheck(check: TimingCheck): string {
  const lines = [`=== TIMING CHECK (${check.ok ? "ok" : "violated"}) ===`];
  for (const row of check.rows) {
    const verdict = row.slackMs >= 0 ? "OK  " : "FAIL";
    lines.push(`  ${verdict} ${row.constraint.padEnd(22)} slack ${String(row.slackMs).padStart(7)}ms`);
    if (row.slackMs < 0) lines.push(`       ${row.detail}`);
  }
  return lines.join("\n");
}
