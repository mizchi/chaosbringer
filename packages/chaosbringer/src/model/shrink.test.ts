import { describe, expect, it } from "vitest";
import { PLAN_OUTCOMES, type FaultPlan, type PlanOutcome, type PlanStep } from "./plan.js";
import type { MismatchField, PlanMismatch } from "./runner.js";
import {
  INCONCLUSIVE_FIELDS,
  OUTCOME_STRENGTH,
  classifyVerdict,
  fieldsOf,
  planWithSteps,
  shrinkCandidates,
  shrinkPlan,
  shrinkableFields,
  type ShrinkStep,
  unrankedOutcomes,
  weakerOutcomes,
} from "./shrink.js";

const step = (over: Partial<PlanStep> = {}): PlanStep => ({
  order: 0,
  rule: "cart",
  outcome: "hang",
  occurrence: 0,
  ...over,
});

// `unhandledRejection: false` is the contract these plans are shrunk against:
// "no rejection escapes", which is true of the app under any schedule. A plan
// stating only `expect.ui` has nothing shrinkable — see the tests for that.
const plan = (over: Partial<FaultPlan> = {}): FaultPlan => ({
  name: "p",
  schedule: [step()],
  expect: { ui: "error", unhandledRejection: false },
  ...over,
});

const mismatch = (field: MismatchField): PlanMismatch => ({
  plan: "p",
  field,
  expected: "x",
  actual: "y",
  detail: "d",
});

describe("classifyVerdict", () => {
  // The reason this is not a boolean predicate. `ddmin` takes
  // `Promise<boolean>`, and feeding an undecidable run into it forces a vote
  // that is wrong either way: "clean" discards a candidate that does fail, so
  // the reported minimum is smaller than the truth *and* moves with machine
  // load; "reproduces" builds the answer on a measurement that was invalid.
  it("calls an undecided run inconclusive, not clean", () => {
    expect(classifyVerdict({ mismatches: [mismatch("undecided")] }, ["ui"])).toBe("inconclusive");
  });

  it("calls a probeError run inconclusive even when a real mismatch is also present", () => {
    // `probeError` means the action may never have driven the app, so nothing
    // observed afterwards is evidence — including the `ui` mismatch sitting
    // next to it. Trusting the `ui` field here would keep a candidate on the
    // strength of a run that never exercised the app.
    expect(
      classifyVerdict({ mismatches: [mismatch("ui"), mismatch("probeError")] }, ["ui"]),
    ).toBe("inconclusive");
  });

  it("calls a skipped plan inconclusive", () => {
    // An order-sensitive plan is refused rather than run. No evidence either
    // way, so it must not read as "the failure is gone".
    expect(
      classifyVerdict({ mismatches: [], skipped: "order-sensitive" }, ["ui"]),
    ).toBe("inconclusive");
  });

  it("reproduces only when a targeted field comes back", () => {
    expect(classifyVerdict({ mismatches: [mismatch("ui")] }, ["ui"])).toBe("reproduces");
    expect(classifyVerdict({ mismatches: [] }, ["ui"])).toBe("clean");
  });

  it("treats a different failure as clean, not as a reproduction", () => {
    // The point of `target`. A candidate that fails some *other* way is a
    // different finding; keeping it would let shrinking wander off and then
    // present its minimum as the minimum for the bug you started with.
    expect(classifyVerdict({ mismatches: [mismatch("injection")] }, ["ui"])).toBe("clean");
  });

  it("reproduces when any one of several targeted fields returns", () => {
    expect(
      classifyVerdict({ mismatches: [mismatch("ui@late")] }, ["ui", "ui@late"]),
    ).toBe("reproduces");
  });

  it("keeps both inconclusive fields in one place", () => {
    // Two readers need this set; a second copy is how one loses `probeError`.
    expect([...INCONCLUSIVE_FIELDS].sort()).toEqual(["probeError", "undecided"]);
  });
});

describe("fieldsOf", () => {
  it("deduplicates and orders, so a target set compares stably", () => {
    expect(fieldsOf([mismatch("ui"), mismatch("injection"), mismatch("ui")])).toEqual([
      "injection",
      "ui",
    ]);
  });
});

describe("planWithSteps", () => {
  it("closes the order gaps a deletion leaves behind", () => {
    // `PlanStep.order` is documented as "gaps closed" and the runner sorts by
    // it, so keeping the original numbers after a deletion breaks the type's
    // own contract.
    const p = plan({
      schedule: [
        step({ order: 0, rule: "a" }),
        step({ order: 1, rule: "b" }),
        step({ order: 2, rule: "c" }),
      ],
    });
    const kept = [p.schedule[0]!, p.schedule[2]!];
    expect(planWithSteps(p, kept).schedule).toEqual([
      { order: 0, rule: "a", outcome: "hang", occurrence: 0 },
      { order: 1, rule: "c", outcome: "hang", occurrence: 0 },
    ]);
  });

  it("does not renumber occurrence", () => {
    // `occurrence` indexes calls the *app* makes on a rule. Deleting a
    // schedule step does not change how many times the app calls it, so
    // renumbering would retarget the fault at a different request.
    const p = plan({ schedule: [step({ occurrence: 3 })] });
    expect(planWithSteps(p, p.schedule).schedule[0]!.occurrence).toBe(3);
  });

  it("carries the rest of the plan through untouched", () => {
    const p = plan({ spec: "s.qnt", orderSensitive: true, expect: { ui: "error", calls: { cart: 2 } } });
    const out = planWithSteps(p, p.schedule);
    expect(out.name).toBe("p");
    expect(out.spec).toBe("s.qnt");
    expect(out.orderSensitive).toBe(true);
    expect(out.expect).toEqual({ ui: "error", calls: { cart: 2 } });
  });
});

describe("the outcome strength order", () => {
  it("ranks every outcome the plan format allows", () => {
    // Two lists of the same thing; the one nothing reads is the one that
    // rots. A new outcome added to `PLAN_OUTCOMES` and not ranked here would
    // otherwise make the shrinker silently skip that dimension.
    expect(unrankedOutcomes(PLAN_OUTCOMES)).toEqual([]);
  });

  it("actually reports an unranked outcome", () => {
    // Without this the assertion above passes against an `unrankedOutcomes`
    // that always returns `[]` — a guard satisfied by reporting nothing,
    // which is the failure mode it exists to prevent. Mutation-confirmed:
    // gutting the function fails here and nowhere else.
    expect(unrankedOutcomes([...PLAN_OUTCOMES, "invented" as never])).toEqual(["invented"]);
  });

  it("puts pass weakest and hang strongest", () => {
    // The two relations in the table that are beyond argument: `pass` injects
    // nothing, `hang` never settles.
    expect(OUTCOME_STRENGTH[0]).toBe("pass");
    expect(OUTCOME_STRENGTH[OUTCOME_STRENGTH.length - 1]).toBe("hang");
  });

  it("offers strictly weaker outcomes, strongest-weaker first", () => {
    // Strongest-first so the first candidate that still fails is the closest
    // to the original — a smaller step down is a more faithful minimum than
    // leaping straight to `pass`.
    expect(weakerOutcomes("abort")).toEqual(["reject", "reject-body", "status", "pass"]);
    expect(weakerOutcomes("status")).toEqual(["pass"]);
  });

  it("offers nothing weaker than the weakest", () => {
    expect(weakerOutcomes("pass")).toEqual([]);
  });

  it("offers nothing for an outcome it cannot rank", () => {
    // No ranking beats a wrong ranking; the gap is reported by
    // `unrankedOutcomes` rather than guessed at here.
    expect(weakerOutcomes("invented" as never)).toEqual([]);
  });
});

describe("shrinkCandidates", () => {
  it("weakens one step at a time and never more than one edit per candidate", () => {
    const p = plan({
      schedule: [step({ order: 0, rule: "a", outcome: "status" }), step({ order: 1, rule: "b", outcome: "status" })],
    });
    const cs = shrinkCandidates(p);
    const outcomeEdits = cs.filter((c) => c.dimension === "outcome");
    expect(outcomeEdits).toHaveLength(2); // status → pass, for each step
    for (const c of outcomeEdits) {
      const changed = c.plan.schedule.filter((s, i) => s.outcome !== p.schedule[i]!.outcome);
      expect(changed).toHaveLength(1);
    }
  });

  it("lowers occurrence downward only, zero first", () => {
    const p = plan({ schedule: [step({ outcome: "pass", occurrence: 2 })] });
    const occ = shrinkCandidates(p).filter((c) => c.dimension === "occurrence");
    expect(occ.map((c) => c.plan.schedule[0]!.occurrence)).toEqual([0, 1]);
  });

  it("generates no step deletions", () => {
    // Deletion is `ddmin`'s job. Generating it here as well would be the same
    // search implemented twice, which is how the two disagree later.
    const p = plan({ schedule: [step({ rule: "a" }), step({ rule: "b" })] });
    for (const c of shrinkCandidates(p)) {
      expect(c.plan.schedule).toHaveLength(2);
    }
  });

  it("never touches expect", () => {
    // Dropping an expectation is not a smaller counterexample — it is a
    // weaker claim, and an unstated `expect.ui` is not checked at all, so it
    // would "shrink" a failure into a plan that cannot fail.
    const p = plan({ expect: { ui: "error", unhandledRejection: true, calls: { cart: 1 } } });
    for (const c of shrinkCandidates(p)) {
      expect(c.plan.expect).toEqual(p.expect);
    }
  });

  it("describes each edit well enough to read the shrink log", () => {
    const p = plan({ schedule: [step({ rule: "cart", outcome: "abort", occurrence: 1 })] });
    const edits = shrinkCandidates(p).map((c) => c.edit);
    expect(edits).toContain("step 0 (cart) abort → reject");
    expect(edits).toContain("step 0 (cart) occurrence 1 → 0");
  });

  it("returns nothing for an already-minimal plan", () => {
    // `pass` at occurrence 0 has nowhere left to go on either dimension, so a
    // driver can tell "no candidates" from "candidates all failed".
    expect(shrinkCandidates(plan({ schedule: [step({ outcome: "pass", occurrence: 0 })] }))).toEqual([]);
  });
});

/**
 * A fake oracle. `fails` decides, from a candidate plan, whether the failure
 * reproduces — so a test states its bug as a predicate over plans and then
 * checks that shrinking finds the smallest plan satisfying it.
 */
const oracle = (
  fails: (p: FaultPlan) => boolean | "inconclusive",
  field: MismatchField = "unhandledRejection",
) => {
  const seen: FaultPlan[] = [];
  const run = async (p: FaultPlan) => {
    seen.push(p);
    const verdict = fails(p);
    if (verdict === "inconclusive") return { mismatches: [mismatch("undecided")] };
    return { mismatches: verdict ? [mismatch(field)] : [] };
  };
  return { run, seen };
};

const sched = (...specs: Array<[string, PlanOutcome, number]>): PlanStep[] =>
  specs.map(([rule, outcome, occurrence], order) => ({ order, rule, outcome, occurrence }));

const describePlan = (p: FaultPlan): string =>
  p.schedule.map((s) => `${s.rule}:${s.outcome}@${s.occurrence}`).join(",");

describe("shrinkPlan", () => {
  it("finds the one step that matters in a schedule of five", () => {
    // The motivating case: a model checker hands you a long counterexample and
    // no indication of which part is load-bearing.
    const p = plan({
      schedule: sched(
        ["a", "pass", 0],
        ["b", "pass", 0],
        ["cart", "hang", 0],
        ["c", "pass", 0],
        ["d", "pass", 0],
      ),
    });
    const { run } = oracle((c) => c.schedule.some((s) => s.rule === "cart" && s.outcome === "hang"));
    return shrinkPlan({ plan: p, run }).then((r) => {
      expect(describePlan(r.minimal)).toBe("cart:hang@0");
      expect(r.stop).toBe("1-minimal");
      expect(r.converged).toBe(true);
    });
  });

  it("weakens an outcome as far as the failure allows, and no further", async () => {
    // `hang` was what the model said; if a plain 500 breaks the app too, that
    // is the simpler statement and the one worth reporting.
    const p = plan({ schedule: sched(["cart", "hang", 0]) });
    const { run } = oracle((c) => c.schedule[0]!.outcome !== "pass");
    const r = await shrinkPlan({ plan: p, run });
    expect(describePlan(r.minimal)).toBe("cart:status@0");
    expect(r.converged).toBe(true);
  });

  it("lowers an occurrence to the first call that still fails", async () => {
    const p = plan({ schedule: sched(["cart", "abort", 3]) });
    const { run } = oracle((c) => c.schedule[0]!.occurrence >= 2);
    const r = await shrinkPlan({ plan: p, run });
    expect(r.minimal.schedule[0]!.occurrence).toBe(2);
  });

  it("alternates the two passes, so weakening can unlock a deletion", async () => {
    // The reason the passes loop rather than running once each. This fake bug
    // fires on a 500 from `a` alone, but under a hang from `a` it also needs
    // `b` aborting — so round 1's deletion pass can drop neither step. Only
    // once weakening takes `a` down to `status` does `b` stop mattering, and
    // it takes a *second* deletion pass to notice. Mutation-confirmed:
    // collapsing the outer loop to one round leaves `b:pass` in the reported
    // minimum, and this is the test that catches it.
    const p = plan({ schedule: sched(["a", "hang", 0], ["b", "abort", 0]) });
    const at = (c: FaultPlan, rule: string) => c.schedule.find((s) => s.rule === rule)?.outcome;
    const { run } = oracle(
      (c) => at(c, "a") === "status" || (at(c, "a") === "hang" && at(c, "b") === "abort"),
    );
    const r = await shrinkPlan({ plan: p, run });
    expect(describePlan(r.minimal)).toBe("a:status@0");
    expect(r.stop).toBe("1-minimal");
  });

  it("refuses to shrink a plan that does not reproduce, rather than shrinking it to nothing", async () => {
    // Without the baseline every candidate is `clean`, `ddmin` keeps whatever
    // it started with, and the caller is handed the original plan labelled a
    // minimum. The honest answer is that there was no failure to minimise.
    const p = plan({ schedule: sched(["a", "pass", 0], ["b", "pass", 0]) });
    const { run, seen } = oracle(() => false);
    const r = await shrinkPlan({ plan: p, run });
    expect(r.stop).toBe("not-reproducible");
    expect(r.converged).toBe(false);
    expect(r.minimal).toBe(p);
    expect(seen).toHaveLength(1); // baseline only — no budget wasted on a non-bug
    expect(r.note).toMatch(/no mismatches/);
  });

  it("stops instead of shrinking when the original plan cannot be judged", async () => {
    const p = plan({ schedule: sched(["cart", "hang", 0], ["b", "hang", 0]) });
    const { run } = oracle(() => "inconclusive");
    const r = await shrinkPlan({ plan: p, run, target: ["unhandledRejection"] });
    expect(r.stop).toBe("inconclusive");
    expect(r.minimal).toBe(p);
  });

  it("treats a skipped plan as unjudgeable rather than as a fixed bug", async () => {
    const p = plan({ orderSensitive: true, schedule: sched(["cart", "hang", 0]) });
    const r = await shrinkPlan({
      plan: p,
      target: ["unhandledRejection"],
      run: async () => ({ mismatches: [], skipped: "order-sensitive" as const }),
    });
    expect(r.stop).toBe("inconclusive");
    expect(r.note).toMatch(/skipped/);
  });

  it("retries an undecidable candidate before giving up on it", async () => {
    // Undecidability is usually load, not logic: the probe fired too late to
    // separate a slow response from a hang. One retry settles it, and the
    // shrink converges instead of aborting on a machine hiccup.
    const p = plan({ schedule: sched(["cart", "hang", 0], ["b", "pass", 0]) });
    const flaky = new Set<string>();
    const { run } = oracle((c) => {
      const key = describePlan(c);
      if (key === "cart:hang@0" && !flaky.has(key)) {
        flaky.add(key);
        return "inconclusive";
      }
      return c.schedule.some((s) => s.rule === "cart" && s.outcome !== "pass");
    });
    const r = await shrinkPlan({ plan: p, run, retries: 1 });
    expect(describePlan(r.minimal)).toBe("cart:status@0");
    expect(r.stop).toBe("1-minimal");
  });

  it("ends the search when a deletion candidate stays undecidable", async () => {
    // `ddmin` has to be told true or false. Both are inventions here, so the
    // search stops and says so — and still returns a plan that does reproduce.
    const p = plan({ schedule: sched(["cart", "hang", 0], ["b", "hang", 0]) });
    const { run } = oracle((c) => (c.schedule.length === 2 ? true : "inconclusive"));
    const r = await shrinkPlan({ plan: p, run, retries: 0 });
    expect(r.stop).toBe("inconclusive");
    expect(r.converged).toBe(false);
    expect(r.minimal.schedule).toHaveLength(2);
    expect(r.note).toMatch(/undecidable/);
  });

  it("declines an undecidable weakening candidate but keeps going, and does not claim convergence", async () => {
    // Where skipping *is* sound: declining an edit costs minimality, not
    // correctness. So the search finishes the rest of the space — but the
    // result must not be labelled 1-minimal, because part of it went unjudged.
    const p = plan({ schedule: sched(["cart", "abort", 0]) });
    const { run } = oracle((c) => (c.schedule[0]!.outcome === "abort" ? true : "inconclusive"));
    const r = await shrinkPlan({ plan: p, run, retries: 0 });
    expect(describePlan(r.minimal)).toBe("cart:abort@0");
    expect(r.stop).toBe("inconclusive");
    expect(r.converged).toBe(false);
    expect(r.note).toMatch(/declined/);
  });

  it("reports budget exhaustion as budget exhaustion, not as a minimum", async () => {
    // The distinction this whole result type exists for. Returning `converged`
    // here would present "I stopped looking" as "nothing smaller reproduces".
    const p = plan({
      schedule: sched(
        ["a", "hang", 2],
        ["b", "hang", 2],
        ["c", "hang", 2],
        ["d", "hang", 2],
        ["e", "hang", 2],
      ),
    });
    const { run, seen } = oracle((c) => c.schedule.length === 5);
    const r = await shrinkPlan({ plan: p, run, maxRuns: 4 });
    expect(r.stop).toBe("budget");
    expect(r.converged).toBe(false);
    expect(r.runs).toBe(4);
    expect(seen).toHaveLength(4); // never overspends the budget it was given
    expect(r.note).toMatch(/maxRuns=4/);
  });

  it("counts retries against the budget", async () => {
    // A retry is a browser boot like any other. Charging it elsewhere would
    // make `maxRuns` a number the caller cannot use to bound cost.
    const p = plan({ schedule: sched(["cart", "hang", 0], ["b", "hang", 0]) });
    const { run } = oracle(() => "inconclusive");
    const r = await shrinkPlan({ plan: p, run, target: ["unhandledRejection"], retries: 5, maxRuns: 3 });
    expect(r.stop).toBe("budget");
    expect(r.runs).toBe(3);
  });

  it("keeps only the failure it started with, not any failure", async () => {
    // A candidate that breaks differently is a different bug. Following it
    // would produce a minimum for a question nobody asked.
    const p = plan({ schedule: sched(["cart", "hang", 0], ["b", "hang", 0]) });
    const run = async (c: FaultPlan) => ({
      mismatches:
        c.schedule.length === 2
          ? [mismatch("unhandledRejection")]
          : [mismatch("uiInvariant")], // a real failure, but the wrong one
    });
    const r = await shrinkPlan({ plan: p, run });
    expect(r.target).toEqual(["unhandledRejection"]);
    expect(r.minimal.schedule).toHaveLength(2);
    expect(r.stop).toBe("1-minimal");
  });

  it("measures the target from the baseline when the caller does not name one", async () => {
    const p = plan({ schedule: sched(["cart", "hang", 0]) });
    const run = async () => ({ mismatches: [mismatch("unhandledRejection@late"), mismatch("uiInvariant")] });
    const r = await shrinkPlan({ plan: p, run });
    expect(r.target).toEqual(["uiInvariant", "unhandledRejection@late"]);
  });

  it("honours a caller-supplied target over what the baseline happens to report", async () => {
    // Narrowing the target is how a caller says "this is the finding I care
    // about" when one plan trips several checks at once.
    const p = plan({ schedule: sched(["cart", "hang", 0], ["b", "hang", 0]) });
    const run = async (c: FaultPlan) => ({
      mismatches:
        c.schedule.length === 2 ? [mismatch("unhandledRejection"), mismatch("uiInvariant")] : [mismatch("unhandledRejection")],
    });
    const r = await shrinkPlan({ plan: p, run, target: ["unhandledRejection"] });
    expect(r.target).toEqual(["unhandledRejection"]);
    expect(r.minimal.schedule).toHaveLength(1); // followed `ui`, not `state`
  });

  it("logs every run with its verdict and whether the edit was taken", async () => {
    const p = plan({ schedule: sched(["cart", "hang", 0]) });
    const { run } = oracle((c) => c.schedule[0]!.outcome !== "pass");
    const logged: ShrinkStep[] = [];
    const r = await shrinkPlan({ plan: p, run, onStep: (s) => logged.push(s) });
    expect(logged).toEqual(r.steps);
    expect(logged[0]).toEqual({ run: 1, edit: "baseline", verdict: "reproduces", kept: true });
    // One entry per run spent, numbered 1..runs. A memo hit costs no run and
    // logs nothing, so this stays a usable index rather than repeating a
    // number and reading as if a run happened twice.
    expect(logged.map((s) => s.run)).toEqual(logged.map((_, i) => i + 1));
    expect(logged.at(-1)!.verdict).toBe("clean"); // the edit that ended the search
    expect(r.runs).toBe(logged.length);
  });

  it("leaves an already-minimal plan alone without claiming it failed to converge", async () => {
    const p = plan({ schedule: sched(["cart", "pass", 0]) });
    const { run, seen } = oracle(() => true);
    const r = await shrinkPlan({ plan: p, run });
    expect(describePlan(r.minimal)).toBe("cart:pass@0");
    expect(r.stop).toBe("1-minimal");
    expect(seen).toHaveLength(1);
  });

  it("does not let a browser failure escape as a shrink verdict", async () => {
    // An exception from `run` is not the third state — it is a broken
    // harness, and swallowing it would report a minimum derived from runs
    // that never happened.
    const p = plan({ schedule: sched(["cart", "hang", 0]) });
    await expect(
      shrinkPlan({
        plan: p,
        target: ["unhandledRejection"],
        run: async () => {
          throw new Error("browser closed");
        },
      }),
    ).rejects.toThrow("browser closed");
  });
});

describe("allowOutcomes", () => {
  it("keeps weakening candidates out of an outcome the run cannot honour", () => {
    // `slow-ok`/`slow-trip` need a solved millisecond value; a bridge without
    // `appDeadlineMs` makes the runner throw on them. Both are weaker than
    // `hang`, so generating them anyway would kill the shrink of a plan that
    // runs perfectly well.
    const p = plan({ schedule: sched(["cart", "hang", 0]) });
    const runnable = PLAN_OUTCOMES.filter((o) => o !== "slow-ok" && o !== "slow-trip");
    const outcomes = shrinkCandidates(p, runnable).map((c) => c.plan.schedule[0]!.outcome);
    expect(outcomes).toEqual(["abort", "reject", "reject-body", "status", "pass"]);
  });

  it("does not filter occurrence candidates, which no outcome list constrains", () => {
    const p = plan({ schedule: sched(["cart", "pass", 2]) });
    expect(shrinkCandidates(p, ["pass"]).map((c) => c.dimension)).toEqual([
      "occurrence",
      "occurrence",
    ]);
  });

  it("is forwarded by the driver, so a filtered outcome is never run", async () => {
    // Mutation-confirmed: dropping the argument at the `shrinkCandidates` call
    // site inside `shrinkPlan` fails here and nowhere else.
    const p = plan({ schedule: sched(["cart", "hang", 0]) });
    const { run, seen } = oracle(() => true);
    await shrinkPlan({ plan: p, run, allowOutcomes: ["abort"] });
    expect(seen.map(describePlan)).toEqual(["cart:hang@0", "cart:abort@0"]);
  });
});

describe("shrinkableFields", () => {
  it("counts a bridge invariant as shrinkable under any schedule", () => {
    // `uiInvariants` are the bridge's contract, keyed by the label the page
    // reported — "this label promises the total is visible" is true of the app
    // whatever was injected.
    const f = shrinkableFields(plan({ expect: {} }));
    expect([...f].sort()).toEqual(["uiInvariant", "uiInvariant@late"]);
  });

  it("counts an escaping rejection as shrinkable only when the plan forbids one", () => {
    // `unhandledRejection: false` makes the mismatch "a rejection escaped",
    // which is a bug regardless of the schedule. `true` makes it "the model
    // predicted an escape and none happened" — a prediction about *this*
    // schedule, and a smaller schedule predicts something else.
    expect(shrinkableFields(plan({ expect: { unhandledRejection: false } }))).toContain(
      "unhandledRejection",
    );
    expect(shrinkableFields(plan({ expect: { unhandledRejection: true } }))).not.toContain(
      "unhandledRejection",
    );
  });

  it("excludes every field that compares against a model prediction", () => {
    const f = shrinkableFields(plan({ expect: { ui: "error", state: { n: 1 }, calls: { cart: 1 } } }));
    for (const field of ["ui", "ui@late", "state", "injection", "amplification"] as const) {
      expect(f.has(field)).toBe(false);
    }
  });
});

describe("shrinking a prediction mismatch", () => {
  // The hole a real run found: with `expect.ui: "error"` fixed and the
  // schedule weakened to all-`pass`, the app behaves perfectly and the plan
  // still "fails", so the search reported a minimum that injects nothing.
  it("refuses a ui-only finding instead of minimising it to a plan that injects nothing", async () => {
    const p = plan({ expect: { ui: "error" }, schedule: sched(["cart", "hang", 0], ["b", "hang", 0]) });
    const { run, seen } = oracle(() => true, "ui");
    const r = await shrinkPlan({ plan: p, run });
    expect(r.stop).toBe("schedule-relative");
    expect(r.converged).toBe(false);
    expect(r.minimal).toBe(p);
    expect(r.excludedTarget).toEqual(["ui"]);
    expect(r.note).toMatch(/injects nothing/);
    expect(seen).toHaveLength(1); // measured once, then stopped
  });

  it("refuses a caller-supplied prediction target without spending a run", async () => {
    const p = plan({ schedule: sched(["cart", "hang", 0]) });
    const { run, seen } = oracle(() => true);
    const r = await shrinkPlan({ plan: p, run, target: ["state"] });
    expect(r.stop).toBe("schedule-relative");
    expect(seen).toHaveLength(0);
    expect(r.runs).toBe(0);
  });

  it("shrinks the contract half and says which finding it left behind", async () => {
    // The common case: one plan trips both. The rejection is minimisable, the
    // label is not, and a reader who is not told will assume the minimum
    // covers both.
    const p = plan({ schedule: sched(["cart", "hang", 0], ["b", "pass", 0]) });
    const run = async (c: FaultPlan) => ({
      mismatches: c.schedule.some((s) => s.rule === "cart")
        ? [mismatch("unhandledRejection"), mismatch("ui")]
        : [mismatch("ui")],
    });
    const r = await shrinkPlan({ plan: p, run });
    expect(r.target).toEqual(["unhandledRejection"]);
    expect(r.excludedTarget).toEqual(["ui"]);
    expect(r.minimal.schedule.map((s) => s.rule)).toEqual(["cart"]);
    expect(r.stop).toBe("1-minimal");
    expect(r.converged).toBe(true);
    expect(r.note).toMatch(/has not been shown to preserve it/);
  });

  it("still distinguishes a plan that simply did not fail", async () => {
    // `schedule-relative` and `not-reproducible` are different answers and
    // must not collapse: one is "it failed and I cannot minimise that", the
    // other is "it did not fail".
    const p = plan({ expect: { ui: "error" }, schedule: sched(["cart", "hang", 0]) });
    const { run } = oracle(() => false, "ui");
    const r = await shrinkPlan({ plan: p, run });
    expect(r.stop).toBe("not-reproducible");
    expect(r.excludedTarget).toEqual([]);
  });

  it("does not mistake an undecidable baseline for a prediction-only finding", async () => {
    const p = plan({ expect: { ui: "error" }, schedule: sched(["cart", "hang", 0]) });
    const { run } = oracle(() => "inconclusive", "ui");
    const r = await shrinkPlan({ plan: p, run });
    expect(r.stop).toBe("inconclusive");
  });
});

describe("candidate memo", () => {
  it("does not re-run a candidate the alternating passes offer twice", async () => {
    // The waste a real run showed. Weakening walks `hang` all the way down to
    // `status`, accepting each step, and rejects `pass` at the bottom. The
    // round made progress, so a second round re-offers every rejected
    // candidate — including that `pass`. Each offer is a browser boot, so the
    // second one must come out of the memo.
    // Mutation-confirmed: removing the memo read adds a ninth run here.
    const p = plan({ schedule: sched(["cart", "hang", 0]) });
    const { run, seen } = oracle((c) => c.schedule[0]!.outcome !== "pass");
    const r = await shrinkPlan({ plan: p, run });
    expect(seen.map((c) => c.schedule[0]!.outcome)).toEqual([
      "hang", // baseline
      "slow-trip",
      "slow-ok",
      "abort",
      "reject",
      "reject-body",
      "status",
      "pass", // rejected once, and only once
    ]);
    expect(r.runs).toBe(8);
    expect(describePlan(r.minimal)).toBe("cart:status@0");
    expect(r.stop).toBe("1-minimal");
  });

  it("re-asks a candidate it could not judge rather than caching the non-answer", async () => {
    // `inconclusive` is the one verdict worth asking again for: it means the
    // measurement failed, not that the app is fine. Caching it would freeze a
    // declined candidate as declined for the rest of the search, and the
    // reported minimum would be one edit larger than the truth.
    // Mutation-confirmed: caching it leaves `status` as the minimum here.
    // `hang` so the first round has other edits to accept — a round that
    // changes nothing ends the search, and then there is no second offer to
    // test.
    const p = plan({ schedule: sched(["cart", "hang", 0]) });
    let asked = 0;
    const { run } = oracle((c) => {
      if (c.schedule[0]!.outcome !== "pass") return true;
      asked++;
      return asked === 1 ? "inconclusive" : true;
    });
    const r = await shrinkPlan({ plan: p, run, retries: 0 });
    expect(asked).toBe(2);
    expect(describePlan(r.minimal)).toBe("cart:pass@0");
    // Declined once and never judged as clean, so the search cannot claim it
    // covered the whole space.
    expect(r.stop).toBe("inconclusive");
    expect(r.converged).toBe(false);
  });
});
