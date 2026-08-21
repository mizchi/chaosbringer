/**
 * Deterministic, occurrence-indexed fault decisions.
 *
 * Every fault layer in this package historically decided whether to fire by
 * rolling a seeded RNG against `probability`. That makes a run *reproducible*
 * but not *enumerable*: you cannot say "fail the first call and let the retry
 * through", and you cannot enumerate the combinations a run never attempted.
 *
 * A `FaultSchedule` replaces the roll with a decision table indexed by
 * **occurrence** — the 0-based count of times this fault has already matched:
 *
 *   faults.status(500, {
 *     urlPattern: /\/api\/cart/,
 *     schedule: { decisions: ["inject", "pass"] },   // 1st call 500s, retry works
 *   })
 *
 * `probability` and `schedule` are mutually exclusive (validated); a rule with
 * neither always injects, exactly as before.
 *
 * The same shape is understood by all four layers (network `FaultRule`,
 * `LifecycleFault`, `RuntimeFault`, `IframeFault`). Two layers evaluate it in
 * Node (`decideFault`) and two inside the page, so the in-page evaluator is
 * generated from `buildDecisionHelperSource()` here rather than hand-written
 * twice.
 */

import type { FaultDecision, FaultSchedule, Rng } from "./types.js";

/** Anything carrying the two mutually exclusive firing policies. */
export interface ScheduledFaultLike {
  probability?: number;
  schedule?: FaultSchedule;
}

/**
 * Decision for a given occurrence of a scheduled fault.
 *
 * Past the end of `decisions`, `afterEnd` decides:
 *   - `"pass"` (default) — the schedule is spent, never fire again
 *   - `"inject"`         — keep firing forever
 *   - `"repeat"`         — cycle the table (`decisions[occurrence % length]`)
 *
 * A non-integer or negative `occurrence` yields `"pass"`: callers derive it
 * from a counter, and a broken counter must not turn into surprise faults.
 */
export function scheduleDecisionAt(
  schedule: FaultSchedule,
  occurrence: number,
): FaultDecision {
  const decisions = schedule.decisions;
  if (decisions.length === 0) return "pass";
  if (!Number.isInteger(occurrence) || occurrence < 0) return "pass";
  if (occurrence < decisions.length) return decisions[occurrence]!;
  switch (schedule.afterEnd ?? "pass") {
    case "inject":
      return "inject";
    case "repeat":
      return decisions[occurrence % decisions.length]!;
    default:
      return "pass";
  }
}

/**
 * Decide whether a fault fires on this occurrence.
 *
 * `schedule` wins when present and consumes no RNG at all — a scheduled run
 * leaves the seed sequence (and therefore chaos action selection) untouched.
 * Otherwise this is the historical probability roll, with the same
 * "don't draw for p >= 1" property as `shouldFireProbability`, so adding a
 * probability-1 rule to a config still cannot shift an existing seed.
 *
 * **Behaviour change, and it is a real one:** `p <= 0` returns `"pass"`
 * *without* drawing. The inline roll this replaced on the network layer drew
 * first and then passed, so a seeded config carrying a `probability: 0` rule —
 * the ordinary way to park a rule without deleting it — consumes one fewer
 * random number than it used to and therefore produces a different action
 * sequence. Not drawing is the right behaviour (a rule that can never fire has
 * nothing to roll for), but seed stability is this library's headline property,
 * so it is stated here and in `chaosbringer`'s README rather than discovered.
 * `probability: 1` and values in `(0, 1)` are unaffected, and the lifecycle
 * layer already short-circuited `0` via `shouldFireProbability`.
 */
export function decideFault(
  rule: ScheduledFaultLike,
  occurrence: number,
  rng: Rng,
): FaultDecision {
  if (rule.schedule) return scheduleDecisionAt(rule.schedule, occurrence);
  const p = rule.probability;
  if (p === undefined || p >= 1) return "inject";
  if (p <= 0) return "pass";
  return rng.next() < p ? "inject" : "pass";
}

/**
 * Reject configurations whose firing policy is ambiguous or empty. Called by
 * every layer's compile step so the error surfaces at setup time, naming the
 * offending rule, rather than as a silently ignored field mid-run.
 *
 * `prefix` is the package the *caller* belongs to. `chaosbringer` validates
 * its own options through here, and every other error from that function says
 * `chaosbringer:` — a user who installed one package should not be handed the
 * name of a transitive dependency they never chose.
 */
export function validateFaultSchedule(
  label: string,
  rule: ScheduledFaultLike,
  prefix = "playwright-faults",
): void {
  const { schedule, probability } = rule;
  if (!schedule) return;
  if (probability !== undefined) {
    throw new Error(
      `${prefix}: ${label} sets both "probability" and "schedule" — they are mutually exclusive (drop one)`,
    );
  }
  if (!Array.isArray(schedule.decisions) || schedule.decisions.length === 0) {
    throw new Error(
      `${prefix}: ${label} has an empty "schedule.decisions" — list at least one "pass" / "inject"`,
    );
  }
  for (const [i, d] of schedule.decisions.entries()) {
    if (d !== "pass" && d !== "inject") {
      throw new Error(
        `${prefix}: ${label} has an invalid "schedule.decisions[${i}]" (${JSON.stringify(d)}) — expected "pass" or "inject"`,
      );
    }
  }
  const afterEnd = schedule.afterEnd;
  if (afterEnd !== undefined && afterEnd !== "pass" && afterEnd !== "inject" && afterEnd !== "repeat") {
    throw new Error(
      `${prefix}: ${label} has an invalid "schedule.afterEnd" (${JSON.stringify(afterEnd)}) — expected "pass", "inject" or "repeat"`,
    );
  }
}

/**
 * Serialize a schedule for embedding in an init script. Returns `null` when
 * the fault has no schedule, so the generated JS can branch on a single
 * nullish check.
 */
export function serializeSchedule(
  schedule: FaultSchedule | undefined,
): { decisions: FaultDecision[]; afterEnd: "pass" | "inject" | "repeat" } | null {
  if (!schedule) return null;
  return {
    decisions: [...schedule.decisions],
    afterEnd: schedule.afterEnd ?? "pass",
  };
}

/**
 * JS source for the in-page counterpart of `decideFault`, injected into the
 * runtime / iframe init scripts. Defines one function:
 *
 *   __decide(f, occurrence) -> boolean   // true = inject
 *
 * where `f` is a serialized fault descriptor carrying `schedule` (possibly
 * null) and `probability`, and `__nextRoll()` is the script's seeded LCG.
 * Kept as a string constant — and asserted by tests — because the two
 * init-script builders must not drift apart.
 */
export function buildDecisionHelperSource(): string {
  return `const __decide = (f, occurrence) => {
    const s = f.schedule;
    if (!s) {
      // \`undefined\` means "always fire", the same as \`decideFault\`. Both
      // serializers in this package normalise it to 1 before it gets here, so
      // this arm is unreachable through them — but the helper is a public
      // export for callers writing their own init-script layer, and without
      // it \`undefined >= 1\` and \`undefined <= 0\` are both false, so such a
      // caller's fault falls through to \`__nextRoll() < undefined\`: never
      // fires, and burns a draw doing it. Silently never firing is the worst
      // shape a fault can take, and burning the draw breaks the seed
      // stability the paragraph above spends its length defending.
      if (f.probability === undefined || f.probability >= 1) return true;
      if (f.probability <= 0) return false;
      return __nextRoll() < f.probability;
    }
    const d = s.decisions;
    if (!d || d.length === 0) return false;
    if (occurrence < 0 || (occurrence | 0) !== occurrence) return false;
    if (occurrence < d.length) return d[occurrence] === "inject";
    if (s.afterEnd === "inject") return true;
    if (s.afterEnd === "repeat") return d[occurrence % d.length] === "inject";
    return false;
  };`;
}
