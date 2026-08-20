/**
 * `FaultPlan` — the interchange format between the model world and the
 * browser world, and the compiler that produces one from an ITF trace.
 *
 * A plan carries no probabilities, no seeds, and no Quint concepts: an
 * ordered list of per-operation outcomes plus the model's expected result.
 * That makes it a self-contained regression artifact — it diffs readably in
 * review, and replaying it needs nothing but chaosbringer.
 *
 * Everything here is pure. Plans are compiled at dev time (nightly, or by
 * hand when the model changes) and committed; CI only ever *runs* them.
 */

import { finalState, readBool, readString, type ItfState, type ItfTrace, type ItfValue } from "./itf.js";

/**
 * What happens to one operation on one occurrence.
 *
 * These are model-level outcomes, deliberately coarser than fault kinds: the
 * runner maps them onto concrete faults (and a user can override that map).
 */
export type PlanOutcome =
  /** Let it through untouched. */
  | "pass"
  /** The promise rejects (network-failure shape). */
  | "reject"
  /** The promise rejects with an AbortError (user cancel / AbortController). */
  | "abort"
  /** Resolves, then the body consumer rejects (`res.json()`). */
  | "reject-body"
  /** Never settles. */
  | "hang"
  /** Resolves with an HTTP error status (server error, promise still resolves). */
  | "status"
  /**
   * Slow, but inside whatever bound the app sets — the app must still succeed.
   *
   * Deliberately carries no millisecond value: how slow "slow enough to
   * matter, fast enough to tolerate" is depends on the machine, so the runner
   * resolves it from a calibrated timing profile at run time. That keeps a
   * committed plan portable between a laptop and a CI runner.
   */
  | "slow-ok"
  /** Slow past the app's bound — the app must give up and say so. */
  | "slow-trip";

export const PLAN_OUTCOMES: readonly PlanOutcome[] = [
  "pass",
  "reject",
  "abort",
  "reject-body",
  "hang",
  "status",
  "slow-ok",
  "slow-trip",
];

export interface PlanStep {
  /** Position in the model trace (0-based, gaps closed). */
  order: number;
  /** Model operation id. The runner maps it to a URL matcher. */
  rule: string;
  outcome: PlanOutcome;
  /** Which occurrence of `rule` this step targets (0-based, per rule). */
  occurrence: number;
}

export interface PlanExpectation {
  /** Expected app-visible state label, compared against the runner's `uiProbe`. */
  ui?: string;
  /** Whether the model says a rejection escapes every handler. */
  unhandledRejection?: boolean;
}

export interface FaultPlan {
  /** Stable id — file name, report key, and what a failure is reported under. */
  name: string;
  /** Provenance: the spec this was enumerated from. */
  spec?: string;
  /** Model steps in the witness (states - 1). Informational. */
  modelSteps?: number;
  /** The injection plan. */
  schedule: PlanStep[];
  /** The oracle. */
  expect: PlanExpectation;
  /**
   * Set when the plan's outcome depends on the order in which two *different*
   * operations settle. The browser does not let us enforce cross-operation
   * settlement order (see the design doc's determinism boundary), so the
   * runner refuses these by default instead of producing a flaky verdict.
   */
  orderSensitive?: boolean;
}

/** Default mapping from model action names to plan outcomes. */
export const DEFAULT_ACTION_OUTCOMES: Readonly<Record<string, PlanOutcome>> = {
  fulfil: "pass",
  fulfill: "pass",
  resolve: "pass",
  succeed: "pass",
  reject: "reject",
  fail: "reject",
  abort: "abort",
  cancel: "abort",
  rejectBody: "reject-body",
  "reject-body": "reject-body",
  hang: "hang",
  stall: "hang",
  slow: "slow-ok",
  slowOk: "slow-ok",
  tooSlow: "slow-trip",
  timeout: "slow-trip",
  status: "status",
  serverError: "status",
};

/** Action names that carry no injection (setup / stutter steps). */
export const DEFAULT_IGNORED_ACTIONS: readonly string[] = ["init", "start", "stutter", "noop", "unchanged"];

export interface CompilePlanOptions {
  /** Plan name. Defaults to the trace's `#meta.source`, else "plan". */
  name?: string;
  /**
   * State variable holding the model's own event log — a list of records
   * with an action field and an operation field. This is the primary source
   * because it survives without `--mbt`. Default `"log"`.
   */
  logVar?: string;
  /** Field naming the action inside a log record. Default `"kind"`. */
  logKindField?: string;
  /** Field naming the operation inside a log record. Default `"op"`. */
  logOpField?: string;
  /** Variable holding the expected UI label in the final state. Default `"ui"`. */
  uiVar?: string;
  /** Variable holding the escaped-rejection flag. Default `"unhandled"`. */
  unhandledVar?: string;
  /** Extra / overriding action → outcome mappings. */
  actionOutcomes?: Record<string, PlanOutcome>;
  /** Action names to drop. Defaults to `DEFAULT_IGNORED_ACTIONS`. */
  ignoreActions?: readonly string[];
  /** `mbt::nondetPicks` key naming the operation, when compiling from --mbt. Default `"op"`. */
  pickOpField?: string;
}

interface RawEvent {
  kind: string;
  op: string;
}

function isRecordValue(v: ItfValue): v is { [key: string]: ItfValue } {
  return (
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    !("tag" in v && "value" in v)
  );
}

/**
 * Events from the model's own log variable. Preferred: the model states
 * explicitly what it did, so the compiler is not guessing from state diffs.
 */
function eventsFromLog(state: ItfState, opts: Required<Pick<CompilePlanOptions, "logVar" | "logKindField" | "logOpField">>): RawEvent[] | null {
  const log = state.vars[opts.logVar];
  if (!Array.isArray(log)) return null;
  const out: RawEvent[] = [];
  for (const entry of log) {
    if (!isRecordValue(entry)) continue;
    const record: { [key: string]: ItfValue } = entry;
    const kind = record[opts.logKindField];
    const op = record[opts.logOpField];
    if (typeof kind !== "string") continue;
    out.push({ kind, op: typeof op === "string" ? op : "" });
  }
  return out;
}

/**
 * Fallback: reconstruct events from `--mbt` metadata, one per state
 * (`mbt::actionTaken` plus the operation from `mbt::nondetPicks`).
 */
function eventsFromMbt(trace: ItfTrace, pickOpField: string): RawEvent[] | null {
  // An empty `actionTaken` is Quint's label for an anonymous branch (the
  // stutter step in `any { … }`), which by definition injects nothing.
  const withAction = trace.states.filter((s) => s.action !== undefined && s.action !== "");
  if (withAction.length === 0) return null;
  return withAction.map((s) => {
    const pick = s.picks?.[pickOpField];
    return { kind: s.action!, op: typeof pick === "string" ? pick : "" };
  });
}

/**
 * Compile one ITF trace into a `FaultPlan`.
 *
 * The trace's *final* state carries the oracle; its event sequence becomes
 * the schedule. Per-rule occurrence numbers are assigned in event order, so
 * two events on the same operation map to occurrence 0 then 1.
 */
export function compilePlan(trace: ItfTrace, opts: CompilePlanOptions = {}): FaultPlan {
  const logVar = opts.logVar ?? "log";
  const logKindField = opts.logKindField ?? "kind";
  const logOpField = opts.logOpField ?? "op";
  const uiVar = opts.uiVar ?? "ui";
  const unhandledVar = opts.unhandledVar ?? "unhandled";
  const outcomes = { ...DEFAULT_ACTION_OUTCOMES, ...(opts.actionOutcomes ?? {}) };
  const ignored = new Set(opts.ignoreActions ?? DEFAULT_IGNORED_ACTIONS);
  const last = finalState(trace);

  const raw =
    eventsFromLog(last, { logVar, logKindField, logOpField }) ??
    eventsFromMbt(trace, opts.pickOpField ?? "op");
  if (raw === null) {
    throw new Error(
      `chaosbringer/model: trace has neither a "${logVar}" log variable nor --mbt metadata — one is required to know what the model did`,
    );
  }

  const perRule = new Map<string, number>();
  const schedule: PlanStep[] = [];
  for (const event of raw) {
    if (ignored.has(event.kind)) continue;
    const outcome = outcomes[event.kind];
    if (outcome === undefined) {
      throw new Error(
        `chaosbringer/model: model action "${event.kind}" has no outcome mapping — add it to actionOutcomes or ignoreActions`,
      );
    }
    if (event.op === "") {
      throw new Error(
        `chaosbringer/model: model action "${event.kind}" carries no operation id — the log entry needs a "${logOpField}" field`,
      );
    }
    const occurrence = perRule.get(event.op) ?? 0;
    perRule.set(event.op, occurrence + 1);
    schedule.push({ order: schedule.length, rule: event.op, outcome, occurrence });
  }

  const plan: FaultPlan = {
    name: opts.name ?? trace.source ?? "plan",
    schedule,
    expect: {},
    modelSteps: trace.states.length - 1,
  };
  if (trace.source !== undefined) plan.spec = trace.source;
  const ui = readString(last, uiVar);
  if (ui !== undefined) plan.expect.ui = ui;
  const unhandled = readBool(last, unhandledVar);
  if (unhandled !== undefined) plan.expect.unhandledRejection = unhandled;
  return plan;
}

/**
 * Key a plan by the *multiset* of its steps — order dropped, per-rule
 * occurrence kept.
 */
function multisetKey(plan: FaultPlan): string {
  return plan.schedule
    .map((s) => `${s.rule}@${s.occurrence}=${s.outcome}`)
    .sort()
    .join(",");
}

function expectationKey(plan: FaultPlan): string {
  return `${plan.expect.ui ?? ""}|${plan.expect.unhandledRejection ?? ""}`;
}

/**
 * Flag plans whose verdict depends on cross-operation settlement order.
 *
 * We can enforce *which* outcome each operation gets, but not which of two
 * concurrent operations settles first — so if two plans inject the same
 * multiset of outcomes yet the model expects different results, replaying
 * either would be a coin flip. Both get `orderSensitive: true`; the runner
 * skips them unless explicitly allowed, and coverage reports them rather
 * than pretending the state was covered.
 *
 * Returns the same plans (new objects when the flag changed).
 */
export function markOrderSensitivePlans(plans: readonly FaultPlan[]): FaultPlan[] {
  const byMultiset = new Map<string, FaultPlan[]>();
  for (const plan of plans) {
    const key = multisetKey(plan);
    const bucket = byMultiset.get(key);
    if (bucket) bucket.push(plan);
    else byMultiset.set(key, [plan]);
  }
  const sensitive = new Set<string>();
  for (const bucket of byMultiset.values()) {
    if (bucket.length < 2) continue;
    const expectations = new Set(bucket.map(expectationKey));
    if (expectations.size > 1) for (const p of bucket) sensitive.add(p.name);
  }
  return plans.map((p) =>
    sensitive.has(p.name) ? { ...p, orderSensitive: true } : p,
  );
}

/** Structural validation of a hand-written or round-tripped plan. */
export function validatePlan(plan: FaultPlan): void {
  const where = `plan "${plan.name}"`;
  if (typeof plan.name !== "string" || plan.name.length === 0) {
    throw new Error(`chaosbringer/model: plan is missing a "name"`);
  }
  if (!Array.isArray(plan.schedule)) {
    throw new Error(`chaosbringer/model: ${where} is missing a "schedule" array`);
  }
  const seen = new Set<string>();
  for (const [i, step] of plan.schedule.entries()) {
    if (typeof step.rule !== "string" || step.rule.length === 0) {
      throw new Error(`chaosbringer/model: ${where} step ${i} has no "rule"`);
    }
    if (!PLAN_OUTCOMES.includes(step.outcome)) {
      throw new Error(
        `chaosbringer/model: ${where} step ${i} has an unknown outcome ${JSON.stringify(step.outcome)}`,
      );
    }
    if (!Number.isInteger(step.occurrence) || step.occurrence < 0) {
      throw new Error(
        `chaosbringer/model: ${where} step ${i} has an invalid occurrence ${JSON.stringify(step.occurrence)}`,
      );
    }
    const key = `${step.rule}@${step.occurrence}`;
    if (seen.has(key)) {
      throw new Error(
        `chaosbringer/model: ${where} assigns two outcomes to ${key} — one occurrence can only have one outcome`,
      );
    }
    seen.add(key);
  }
  if (plan.expect === undefined || typeof plan.expect !== "object") {
    throw new Error(`chaosbringer/model: ${where} is missing an "expect" object`);
  }
}
