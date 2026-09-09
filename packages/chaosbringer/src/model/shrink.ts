/**
 * Shrinking a failing `FaultPlan` down to the smallest plan that still fails
 * the same way.
 *
 * A model checker hands you whichever counterexample its search happened to
 * reach first. A twelve-step schedule where two steps matter is a normal
 * output, and the reader has no way to tell which two. Shrinking answers that
 * by re-running smaller candidates and keeping the ones that still fail — the
 * standard property-based-testing move, applied to a fault schedule instead of
 * a generated value.
 *
 * The engine is already here: `ddmin` in `../minimize.js` is Zeller's delta
 * debugging over a sequence with an async predicate, order-preserving and
 * deterministic. Step deletion is exactly a minimal-subsequence problem, so
 * this module supplies the predicate rather than a second search. What ddmin
 * cannot express — weakening an outcome, lowering an occurrence — is a greedy
 * pass over the already-minimal step set.
 *
 * Two things make plan shrinking different from trace shrinking, and both are
 * about not lying:
 *
 *   1. **The oracle has three answers, not two.** A candidate can still fail,
 *      no longer fail, or be *undecidable* — the probe fired too late to
 *      distinguish a bounded app from an unbounded one (`undecided`), or the
 *      bridge itself threw (`probeError`). A boolean predicate has to vote,
 *      and both votes are wrong: calling it "no longer fails" discards a
 *      candidate that does fail, so the reported minimum is smaller than the
 *      truth and moves with machine load; calling it "still fails" builds the
 *      result on a measurement that was invalid. `classifyVerdict` keeps the
 *      third state, and the driver retries or stops rather than guessing.
 *
 *   2. **Same failure, not any failure.** A candidate counts only if it
 *      reproduces *the fields the original produced*. Without that, shrinking
 *      wanders into a different bug and presents its minimum as the minimum
 *      for the one you started with.
 *
 *   3. **Contracts shrink; predictions do not.** A plan's `expect` is computed
 *      by the model *for that schedule*, and shrinking changes the schedule
 *      without being able to recompute it. So a mismatch against a prediction
 *      (`expect.ui`, `expect.state`, `expect.calls`) says nothing about a
 *      smaller plan: weaken every step to `pass` and `expect.ui: "error"`
 *      "reproduces" beautifully, against an app that is behaving perfectly.
 *      A mismatch against a *contract* — a rejection escaped, a label
 *      contradicted what it promises about the page — is a statement about
 *      the app alone and survives any edit to the schedule. Only those can be
 *      shrunk on, and a target that has none of them is refused rather than
 *      answered wrongly. This was found by running the search against a real
 *      app, where it happily "minimised" a `ui` finding to a plan that
 *      injects nothing at all.
 */

import { ddmin } from "../ddmin.js";
import type { FaultPlan, PlanOutcome, PlanStep } from "./plan.js";
import type { MismatchField, PlanMismatch, PlanRunResult } from "./runner.js";

/**
 * What one candidate run told us.
 *
 * `inconclusive` is the whole reason this is not a boolean — see the header.
 */
export type ShrinkVerdict = "reproduces" | "clean" | "inconclusive";

/**
 * Mismatch fields that mean "the run could not decide", as opposed to "the app
 * was wrong". Kept as a set rather than inlined because the shrink driver and
 * the reporter both need it, and a second copy is how one of them ends up
 * missing `probeError`.
 */
export const INCONCLUSIVE_FIELDS: ReadonlySet<MismatchField> = new Set<MismatchField>([
  "undecided",
  "probeError",
]);

/** The mismatch fields a result reports, deduplicated and ordered. */
export function fieldsOf(mismatches: readonly PlanMismatch[]): MismatchField[] {
  return [...new Set(mismatches.map((m) => m.field))].sort();
}

/**
 * Mismatch fields whose meaning does not depend on the schedule that produced
 * them — the ones it is sound to shrink on.
 *
 * The distinction is contract versus prediction:
 *
 *   - `uiInvariant` / `uiInvariant@late` are the *bridge's* invariants, keyed
 *     by the label the page reported. "This label promises the total is
 *     visible" is true of the app under any schedule.
 *   - `unhandledRejection` / `unhandledRejection@late` qualify only when the
 *     plan says `false`. Then the mismatch is "a rejection escaped every
 *     handler", which is a bug whatever was injected. With `expect:
 *     unhandledRejection: true` the mismatch is the other direction — the
 *     model predicted an escape and none happened — and that is a prediction
 *     about this schedule, not a contract.
 *
 * Everything else compares against a number or label the model computed for
 * the original schedule: `ui`, `state`, and the `injection`/`amplification`
 * pair that `expect.calls` and the schedule's own occurrence spans drive. A
 * smaller plan does not carry a recomputed prediction — chaosbringer has no
 * model checker at run time, by design — so those comparisons become
 * meaningless the moment a step changes, and they fail for the trivial reason
 * that the plan no longer describes the run.
 */
export function shrinkableFields(plan: FaultPlan): Set<MismatchField> {
  const out = new Set<MismatchField>(["uiInvariant", "uiInvariant@late"]);
  if (plan.expect.unhandledRejection === false) {
    out.add("unhandledRejection");
    out.add("unhandledRejection@late");
  }
  return out;
}

/**
 * Classify a candidate run against the failure we are trying to preserve.
 *
 * `target` is the field set the original failing plan produced. A candidate
 * reproduces when it produces at least one of those fields — not merely *some*
 * failure, because a plan that fails differently is a different finding and
 * minimising it would answer a question nobody asked.
 *
 * Order matters: inconclusive is checked before `clean`, because a run that
 * could not decide has not shown the failure to be gone. It is checked before
 * `reproduces` too — a result carrying both a real mismatch and a
 * `probeError` is not trustworthy about the real one, since `probeError` means
 * the action may never have driven the app at all.
 */
export function classifyVerdict(
  result: Pick<PlanRunResult, "mismatches" | "skipped">,
  target: readonly MismatchField[],
): ShrinkVerdict {
  // A skipped plan produced no evidence either way. Treating it as `clean`
  // would let the driver shrink past a real minimum on the strength of a run
  // that never happened.
  if (result.skipped !== undefined) return "inconclusive";

  const fields = new Set(result.mismatches.map((m) => m.field));
  for (const f of INCONCLUSIVE_FIELDS) {
    if (fields.has(f)) return "inconclusive";
  }
  return target.some((f) => fields.has(f)) ? "reproduces" : "clean";
}

/**
 * Rebuild a plan around a subset of its steps, closing the `order` gaps.
 *
 * `PlanStep.order` is documented as "0-based, gaps closed", and the runner
 * sorts by it, so a subset that keeps the original numbers would violate the
 * type's own contract the moment a step is dropped. `occurrence` is *not*
 * renumbered: it indexes calls the app makes on that rule, which deleting a
 * schedule step does not change.
 */
export function planWithSteps(plan: FaultPlan, steps: readonly PlanStep[]): FaultPlan {
  return {
    ...plan,
    schedule: steps.map((s, i) => ({ ...s, order: i })),
  };
}

/**
 * How much each outcome perturbs the app, weakest first.
 *
 * Shrinking walks *down* this list: if a bug still reproduces with `status`
 * where the model said `hang`, "a 500 breaks it" is a simpler statement than
 * "a request that never settles breaks it", and simpler statements are what a
 * minimal counterexample is for.
 *
 * The order is a judgement, and only two relations in it are beyond argument:
 * `pass` is weakest because it injects nothing at all, and `hang` is strongest
 * because it never settles. In between, the ranking is "how far from a normal
 * response is this" — a status code is a real HTTP response, a rejected body
 * is a response whose parse fails, an abort is no response, and the slow pair
 * are responses that arrive late. Being a judgement is exactly why shrinking
 * never *assumes* a weaker outcome still fails: it tries it and asks the
 * oracle.
 */
export const OUTCOME_STRENGTH: readonly PlanOutcome[] = [
  "pass",
  "status",
  "reject-body",
  "reject",
  "abort",
  "slow-ok",
  "slow-trip",
  "hang",
];

/** Outcomes strictly weaker than `outcome`, strongest-weaker first. */
export function weakerOutcomes(outcome: PlanOutcome): PlanOutcome[] {
  const i = OUTCOME_STRENGTH.indexOf(outcome);
  // An outcome absent from the table (a future addition someone forgot to
  // rank) yields no candidates rather than a wrong ranking. Reported by
  // `unrankedOutcomes` so it is a visible gap, not a silent one.
  if (i <= 0) return [];
  return OUTCOME_STRENGTH.slice(0, i).reverse();
}

/**
 * Outcomes the strength table does not rank.
 *
 * `PLAN_OUTCOMES` and `OUTCOME_STRENGTH` are two lists of the same thing, and
 * the one that rots is the one nothing reads. A caller that adds an outcome
 * and forgets to rank it would otherwise get a shrinker that silently skips
 * that dimension for those steps.
 */
export function unrankedOutcomes(all: readonly PlanOutcome[]): PlanOutcome[] {
  const ranked = new Set(OUTCOME_STRENGTH);
  return all.filter((o) => !ranked.has(o));
}

/** One candidate plan, with a description of the single edit that produced it. */
export interface ShrinkCandidate {
  plan: FaultPlan;
  /** What was changed, for the shrink log — e.g. `step 2 hang → status`. */
  edit: string;
  dimension: "outcome" | "occurrence";
}

/**
 * Candidates for the dimensions `ddmin` cannot express, in the order to try
 * them: one edit at a time, weakest-first within a step.
 *
 * Deliberately *not* including step deletion — that is `ddmin`'s job, and
 * generating it here too would be the same search in two places.
 *
 * `expect` is never weakened. Dropping an expectation makes the plan assert
 * less, which is not a smaller counterexample but a different, weaker claim —
 * and since an unstated `expect.ui` is no longer checked at all, it would
 * "shrink" a failure into a plan that cannot fail.
 */
export function shrinkCandidates(
  plan: FaultPlan,
  /**
   * Outcomes weakening may substitute *in*. Default: any weaker outcome.
   *
   * Some outcomes are only usable under some configurations — `slow-ok` and
   * `slow-trip` have no portable millisecond value, so a bridge without
   * `appDeadlineMs` makes them a hard error rather than a run. They are both
   * weaker than `hang`, so a `hang` plan on such a bridge would otherwise
   * generate a candidate that throws out of the runner and takes the whole
   * shrink with it. What a candidate is *runnable* here is a fact about the
   * caller's configuration, not about the plan, so the caller supplies it.
   */
  allowOutcomes?: readonly PlanOutcome[],
): ShrinkCandidate[] {
  const out: ShrinkCandidate[] = [];
  const allowed = allowOutcomes === undefined ? undefined : new Set(allowOutcomes);

  plan.schedule.forEach((step, i) => {
    for (const outcome of weakerOutcomes(step.outcome)) {
      if (allowed !== undefined && !allowed.has(outcome)) continue;
      out.push({
        plan: {
          ...plan,
          schedule: plan.schedule.map((s, j) => (j === i ? { ...s, outcome } : s)),
        },
        edit: `step ${i} (${step.rule}) ${step.outcome} → ${outcome}`,
        dimension: "outcome",
      });
    }
  });

  plan.schedule.forEach((step, i) => {
    // Downward only, and 0 first: "it fails on the very first call" is both
    // the simplest statement and, in practice, usually the real bug — a
    // failure that needs the fourth call is a different and rarer claim.
    for (let occ = 0; occ < step.occurrence; occ++) {
      out.push({
        plan: {
          ...plan,
          schedule: plan.schedule.map((s, j) => (j === i ? { ...s, occurrence: occ } : s)),
        },
        edit: `step ${i} (${step.rule}) occurrence ${step.occurrence} → ${occ}`,
        dimension: "occurrence",
      });
    }
  });

  return out;
}

/** What a candidate run has to tell the shrinker. A `PlanRunResult` satisfies it. */
export type ShrinkRunResult = Pick<PlanRunResult, "mismatches" | "skipped">;

/** One candidate run, for the shrink log. */
export interface ShrinkStep {
  /** 1-based count of candidate runs spent, so a log line names its own cost. */
  run: number;
  /** The edit under test — `keep 2/5 steps: cart, checkout`, `step 0 (cart) hang → abort`. */
  edit: string;
  verdict: ShrinkVerdict;
  /** Whether the edit was adopted. False for `clean`, and for a skipped `inconclusive`. */
  kept: boolean;
}

/**
 * Why the search stopped. Distinguishing these is the point: a caller that
 * cannot tell "no smaller plan reproduces this" from "I ran out of runs"
 * will present the second as the first.
 */
export type ShrinkStop =
  /** Every remaining edit was tried and rejected. The result is 1-minimal. */
  | "1-minimal"
  /** `maxRuns` was reached. The result still reproduces, but smaller plans went untried. */
  | "budget"
  /** A candidate stayed undecidable, or the original plan itself was undecidable. */
  | "inconclusive"
  /** The original plan did not reproduce its own failure. Nothing was shrunk. */
  | "not-reproducible"
  /**
   * Every field the plan failed on is a comparison against the model's
   * prediction for *this* schedule, so no smaller schedule can carry it.
   * Nothing was shrunk — see `shrinkableFields`.
   */
  | "schedule-relative";

export interface ShrinkOptions {
  /** The failing plan to minimise. */
  plan: FaultPlan;
  /**
   * Run one candidate and report what the oracle said. Typically a closure
   * over `runPlan` and its browser context; kept as a parameter so the search
   * is testable without one.
   */
  run: (plan: FaultPlan) => Promise<ShrinkRunResult>;
  /**
   * Fields the minimum must keep reproducing. Default: measured from a
   * baseline run of `plan`, which is also what verifies the plan fails at all.
   *
   * Filtered through `shrinkableFields` either way — naming a
   * prediction-relative field here does not make it shrinkable, it stops the
   * search with `stop: "schedule-relative"`. What this is for is *narrowing*:
   * picking one of several contract findings when a plan trips more than one.
   *
   * Granularity is the field, not the individual mismatch: two `uiInvariant`
   * violations on different keys are indistinguishable to the search. There is
   * no way to ask for "the same mismatch" — the numbers in a mismatch
   * legitimately move as the plan shrinks, so equality on them would reject
   * every candidate.
   */
  target?: readonly MismatchField[];
  /**
   * Candidate runs the search may spend, baseline included. Each one boots a
   * browser, so this is the real cost knob. Reaching it stops the search with
   * `stop: "budget"` rather than reporting a minimum it did not establish.
   */
  maxRuns?: number;
  /**
   * Re-runs to spend on an `inconclusive` candidate before giving up on it.
   * Undecidability is often load-induced (the probe fired too late to
   * separate a slow response from a hang), so one retry usually settles it.
   */
  retries?: number;
  /**
   * Outcomes weakening may substitute in, forwarded to `shrinkCandidates`.
   * Leave unset unless the run configuration makes some outcome unusable —
   * see that function. Restricting this narrows the search, so a result can be
   * `1-minimal` over a smaller space than the plan format allows; the excluded
   * outcomes could not have been run anyway.
   */
  allowOutcomes?: readonly PlanOutcome[];
  /** Observer, called once per candidate run. */
  onStep?: (step: ShrinkStep) => void;
}

export interface ShrinkResult {
  /** The plan as handed in. */
  original: FaultPlan;
  /**
   * The smallest plan the search established still reproduces `target`.
   * Equal to `original` when nothing could be removed — or when the search
   * never got going, which `stop` distinguishes.
   */
  minimal: FaultPlan;
  /**
   * The fields `minimal` was required to keep reproducing — the shrinkable
   * subset of what the baseline reported (or of what the caller asked for).
   */
  target: MismatchField[];
  /**
   * Fields the plan failed on that were *left out* of the target because they
   * compare against the model's prediction rather than a contract. Reported
   * rather than dropped silently: a minimum that preserves an escaping
   * rejection has not been shown to preserve the `ui` finding beside it, and
   * a reader who is not told will assume it has.
   */
  excludedTarget: MismatchField[];
  /** Every candidate run, in order. */
  steps: ShrinkStep[];
  /** Candidate runs spent, including the baseline. */
  runs: number;
  /**
   * True only when the search finished the job: `stop === "1-minimal"`. A
   * false here with a smaller `minimal` still means progress — just not a
   * proven minimum.
   */
  converged: boolean;
  stop: ShrinkStop;
  /** Human-readable reason, always set for a `stop` other than `1-minimal`. */
  note?: string;
}

/** Thrown out of a predicate to end the search without lying to `ddmin`. */
class ShrinkAbort extends Error {
  constructor(
    readonly stop: Extract<ShrinkStop, "budget" | "inconclusive">,
    readonly note: string,
  ) {
    super(note);
    this.name = "ShrinkAbort";
  }
}

const DEFAULT_MAX_RUNS = 100;

/** Why a target of prediction-relative fields cannot be shrunk on. */
function explainRelative(fields: readonly MismatchField[], plan: FaultPlan): string {
  const shrinkable = shrinkableFields(plan);
  const relative = fields.filter((f) => !shrinkable.has(f));
  return (
    `nothing was shrunk: ${relative.join(", ")} compare against the model's prediction for ` +
    `this exact schedule (\`expect\`), and a smaller schedule has no recomputed prediction to ` +
    `compare against — chaosbringer runs plans without a model checker, by design. Shrinking ` +
    `on them would "minimise" the plan to one that injects nothing and still call it a ` +
    `reproduction. Shrinkable findings are the contracts: an escaping rejection ` +
    `(needs \`expect.unhandledRejection: false\`) and a \`uiInvariant\` violation. To minimise ` +
    `a prediction mismatch, minimise the model and recompile the plan.`
  );
}

/**
 * Shrink a failing plan to the smallest one that still fails the same way.
 *
 * Two passes, alternating until neither makes progress:
 *
 *   1. **Deletion** — `ddmin` over the schedule, finding a 1-minimal subset of
 *      steps. This is where a twelve-step counterexample becomes two.
 *   2. **Weakening** — a greedy walk over `shrinkCandidates`, taking the first
 *      accepted edit and starting over. Each accepted edit strictly lowers an
 *      outcome's strength or an occurrence index, so the walk terminates.
 *
 * They alternate because they feed each other: weakening a step to `pass`
 * often makes it deletable, and deleting a step can make a neighbour's
 * occurrence reachable at 0. A pass that changes nothing ends the loop, which
 * is what makes the `1-minimal` claim true of both dimensions rather than just
 * the one that ran last.
 *
 * Undecidable candidates are handled differently in the two passes, and the
 * difference is not an inconsistency — it is where skipping is sound.
 * `ddmin`'s predicate must answer, so a candidate that stays undecidable after
 * `retries` ends the search: the alternative is voting, and both votes are
 * wrong (see the header). The greedy pass can simply decline an edit it could
 * not judge and carry on, since declining only costs minimality. Either way
 * the result carries `converged: false` and `stop: "inconclusive"`, because a
 * search that could not judge part of its space has not established a minimum.
 */
export async function shrinkPlan(options: ShrinkOptions): Promise<ShrinkResult> {
  const { plan: original, run, onStep } = options;
  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
  const retries = options.retries ?? 1;
  const steps: ShrinkStep[] = [];
  let runs = 0;

  let excludedTarget: MismatchField[] = [];
  const done = (
    minimal: FaultPlan,
    target: MismatchField[],
    stop: ShrinkStop,
    note?: string,
  ): ShrinkResult => ({
    original,
    minimal,
    target,
    excludedTarget,
    steps,
    runs,
    converged: stop === "1-minimal",
    stop,
    ...(note !== undefined ? { note } : {}),
  });

  /**
   * Run one candidate, retrying while undecidable. Returns the verdict, or
   * throws `ShrinkAbort` when the budget is gone — never a made-up verdict,
   * since a fabricated `clean` shrinks past a real minimum and a fabricated
   * `reproduces` keeps a step on no evidence.
   */
  /**
   * Decisive verdicts already measured, keyed by schedule.
   *
   * The two passes alternate, so a round that made progress re-offers every
   * candidate the previous round rejected — and each one is a browser boot.
   * Only decisive verdicts are cached: an `inconclusive` is exactly the case
   * where re-running can tell you something, which is what `retries` is for.
   *
   * This does assume the oracle answers the same way twice for the same plan,
   * which is the determinism the plan format is built on. Where it does not
   * hold, caching is still the better of the two options: without it the
   * reported minimum depends on which of two disagreeing runs the search
   * happened to see last.
   */
  const memo = new Map<string, Exclude<ShrinkVerdict, "inconclusive">>();
  const keyOf = (p: FaultPlan): string =>
    p.schedule.map((st) => `${st.rule}:${st.outcome}@${st.occurrence}`).join("|");

  const judge = async (
    candidate: FaultPlan,
    target: readonly MismatchField[],
    edit: string,
  ): Promise<ShrinkVerdict> => {
    const key = keyOf(candidate);
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let verdict: ShrinkVerdict = "inconclusive";
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (runs >= maxRuns) {
        throw new ShrinkAbort(
          "budget",
          `stopped after ${runs} run(s): maxRuns=${maxRuns} reached with edits left to try`,
        );
      }
      runs++;
      verdict = classifyVerdict(await run(candidate), target);
      if (verdict !== "inconclusive") {
        memo.set(key, verdict);
        break;
      }
    }
    return verdict;
  };

  const record = (edit: string, verdict: ShrinkVerdict, kept: boolean): void => {
    const step: ShrinkStep = { run: runs, edit, verdict, kept };
    steps.push(step);
    onStep?.(step);
  };

  /**
   * Judge a candidate and log it *if it cost a run*.
   *
   * A memo hit costs nothing, and logging it would put two entries on the
   * same run number — a log that reads as if the run happened twice. The step
   * log is a record of runs spent, and `steps.length === runs` is what makes
   * it usable as one.
   */
  const judgeAndLog = async (
    candidate: FaultPlan,
    target: readonly MismatchField[],
    edit: string,
  ): Promise<ShrinkVerdict> => {
    const before = runs;
    const verdict = await judge(candidate, target, edit);
    if (runs > before) record(edit, verdict, verdict === "reproduces");
    return verdict;
  };

  // Baseline. Without it `target` would be a guess, and a plan that no longer
  // fails would be "shrunk" to whatever the first candidate happened to be.
  // The target is partitioned before anything is run: a field that compares
  // against the model's prediction for this schedule cannot survive an edit to
  // the schedule, so shrinking on it would answer confidently and wrongly.
  const shrinkable = shrinkableFields(original);
  const requested = options.target;
  let baseline: ShrinkVerdict;
  let target: MismatchField[];
  if (requested !== undefined) {
    target = requested.filter((f) => shrinkable.has(f));
    excludedTarget = requested.filter((f) => !shrinkable.has(f));
    if (target.length === 0) {
      return done(original, target, "schedule-relative", explainRelative(requested, original));
    }
    try {
      baseline = await judge(original, target, "baseline");
    } catch (err) {
      if (err instanceof ShrinkAbort) return done(original, target, err.stop, err.note);
      throw err;
    }
  } else {
    if (runs >= maxRuns) {
      return done(original, [], "budget", `maxRuns=${maxRuns} leaves no room for the baseline run`);
    }
    runs++;
    const result = await run(original);
    const reported = fieldsOf(result.mismatches);
    target = reported.filter((f) => shrinkable.has(f));
    excludedTarget = reported.filter(
      (f) => !shrinkable.has(f) && !INCONCLUSIVE_FIELDS.has(f),
    );
    baseline = classifyVerdict(result, target);
    // Measured, then found unusable: distinguish it from "did not fail", so
    // the reader is told the plan *did* fail and why it cannot be minimised.
    if (baseline === "clean" && excludedTarget.length > 0) {
      record("baseline", baseline, false);
      return done(original, target, "schedule-relative", explainRelative(reported, original));
    }
  }
  record("baseline", baseline, baseline === "reproduces");

  if (baseline === "inconclusive") {
    return done(
      original,
      target,
      "inconclusive",
      "the original plan could not be judged — it was skipped, or its run reported " +
        "`undecided`/`probeError`. There is no failure to preserve, so nothing was shrunk.",
    );
  }
  if (baseline === "clean") {
    return done(
      original,
      target,
      "not-reproducible",
      target.length === 0
        ? "the original plan reported no mismatches, so there is nothing to shrink"
        : `the original plan did not reproduce ${target.join(", ")} on this run`,
    );
  }

  let current = original;
  let sawInconclusive = false;

  try {
    // Alternate until a full round changes nothing. `progress` is what makes
    // the terminating round mean "1-minimal in both dimensions".
    for (;;) {
      let progress = false;

      // Pass 1 — deletion.
      if (current.schedule.length >= 2) {
        const kept = await ddmin(current.schedule, async (subset) => {
          const candidate = planWithSteps(current, subset);
          const edit = `keep ${subset.length}/${current.schedule.length} steps: ${subset
            .map((s) => `${s.rule}:${s.outcome}@${s.occurrence}`)
            .join(", ")}`;
          const verdict = await judgeAndLog(candidate, target, edit);
          if (verdict === "inconclusive") {
            throw new ShrinkAbort(
              "inconclusive",
              `a candidate stayed undecidable after ${retries + 1} attempt(s) during step ` +
                `deletion (${edit}). Deletion cannot skip a candidate it could not judge — ` +
                `either answer would be invented — so the search stopped here.`,
            );
          }
          return verdict === "reproduces";
        });
        if (kept.length < current.schedule.length) {
          current = planWithSteps(current, kept);
          progress = true;
        }
      }

      // Pass 2 — weakening. Restart generation after each accepted edit: the
      // candidate list is derived from the plan, and the plan just changed.
      for (;;) {
        const candidates = shrinkCandidates(current, options.allowOutcomes);
        let accepted = false;
        for (const candidate of candidates) {
          const verdict = await judgeAndLog(candidate.plan, target, candidate.edit);
          if (verdict === "inconclusive") sawInconclusive = true;
          if (verdict === "reproduces") {
            current = candidate.plan;
            accepted = true;
            progress = true;
            break;
          }
        }
        if (!accepted) break;
      }

      if (!progress) break;
    }
  } catch (err) {
    if (err instanceof ShrinkAbort) {
      return done(current, target, err.stop, err.note);
    }
    throw err;
  }

  if (sawInconclusive) {
    return done(
      current,
      target,
      "inconclusive",
      "at least one weakening candidate stayed undecidable and was declined. The plan " +
        "reported here does reproduce the failure, but a smaller one may exist among the " +
        "edits that could not be judged.",
    );
  }
  return done(
    current,
    target,
    "1-minimal",
    excludedTarget.length > 0
      ? `minimised against ${target.join(", ")} only. The plan also failed on ` +
        `${excludedTarget.join(", ")}, which compares against the model's prediction for the ` +
        `original schedule; this minimum has not been shown to preserve it.`
      : undefined,
  );
}
