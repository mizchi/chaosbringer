import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aggregateCoverage, findCollapsedPlans, formatModelCoverage, modelRunPassed } from "./coverage.js";
import { decodeItfValue, finalState, parseItfTrace, readBool, readString } from "./itf.js";
import { compilePlansFromTraces, coverageForRun } from "./cli.js";
import { compilePlan, markOrderSensitivePlans, validatePlan, type FaultPlan } from "./plan.js";
import {
  checkUiInvariants,
  compilePlanFaults,
  evaluatePlanOracle,
  faultNameFor,
  drainScheduledWork,
  nextDrainWaitMs,
  observationNameFor,
  resolvePlanTiming,
  validateCallCountRules,
  type PlanOracleInput,
  type PlanRunResult,
} from "./runner.js";
import { envelope, type CalibrationRun } from "./calibrate.js";
import { solveTiming } from "../timing.js";

/**
 * Fixtures are real `quint verify` / `quint run --mbt` output from the
 * feasibility spike (Apalache 0.56.1 / Quint 0.32.0), not hand-written
 * JSON — the parser has to survive what the tools actually emit.
 */
function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("decodeItfValue", () => {
  it("decodes #map into a keyed record", () => {
    expect(
      decodeItfValue({ "#map": [["A", "rejected"], ["B", "pending"]] }),
    ).toEqual({ A: "rejected", B: "pending" });
  });

  it("decodes #tup and #set into arrays", () => {
    expect(decodeItfValue({ "#tup": [1, "x"] })).toEqual([1, "x"]);
    expect(decodeItfValue({ "#set": ["a", "b"] })).toEqual(["a", "b"]);
  });

  it("decodes #bigint within safe range and refuses beyond it", () => {
    expect(decodeItfValue({ "#bigint": "42" })).toBe(42);
    expect(() => decodeItfValue({ "#bigint": "9007199254740993" })).toThrow(/safe integer/);
  });

  it("keeps Quint sum-type variants as { tag, value }", () => {
    expect(decodeItfValue({ tag: "Some", value: "x" })).toEqual({ tag: "Some", value: "x" });
  });

  it("refuses unserializable values instead of guessing", () => {
    expect(() => decodeItfValue({ "#unserializable": "lambda" })).toThrow(/unserializable/);
  });
});

describe("parseItfTrace", () => {
  it("reads a real Apalache counterexample", () => {
    const trace = parseItfTrace(fixture("error_true.itf.json"));
    expect(trace.varNames).toContain("unhandled");
    expect(trace.states.length).toBeGreaterThan(1);
    const last = finalState(trace);
    expect(readString(last, "ui")).toBe("error");
    expect(readBool(last, "unhandled")).toBe(true);
    expect(last.vars.opState).toEqual({ A: "rejected", B: "rejected" });
  });

  it("reads mbt metadata out of a `quint run --mbt` trace", () => {
    const trace = parseItfTrace(fixture("mbt.itf.json"));
    expect(trace.states[0]!.action).toBe("init");
    expect(trace.states[1]!.action).toBe("start");
    // Option-shaped nondet picks are unwrapped: None -> null.
    expect(trace.states[0]!.picks).toEqual({ op: null });
    // mbt keys must not leak into the state variables.
    expect(Object.keys(trace.states[0]!.vars)).not.toContain("mbt::actionTaken");
  });

  it("rejects a document with no states", () => {
    expect(() => parseItfTrace({ vars: [] })).toThrow(/no "states"/);
  });
});

describe("compilePlan", () => {
  it("turns the double-rejection witness into an ordered schedule + oracle", () => {
    const plan = compilePlan(parseItfTrace(fixture("error_true.itf.json")), {
      name: "error_true",
    });
    expect(plan.schedule).toEqual([
      { order: 0, rule: "A", outcome: "reject", occurrence: 0 },
      { order: 1, rule: "B", outcome: "reject", occurrence: 0 },
    ]);
    expect(plan.expect).toEqual({ ui: "error", unhandledRejection: true });
    // `start` carries no injection and must not consume an order slot.
    expect(plan.schedule.some((s) => s.outcome === "pass")).toBe(false);
  });

  it("maps hang actions and keeps the model's stuck prediction", () => {
    const plan = compilePlan(parseItfTrace(fixture("stuck_false.itf.json")), { name: "stuck" });
    expect(plan.schedule.map((s) => s.outcome)).toContain("hang");
    expect(plan.expect.ui).toBe("stuck");
    expect(plan.expect.unhandledRejection).toBe(false);
  });

  it("numbers repeated operations by occurrence", () => {
    const trace = parseItfTrace({
      vars: ["log", "ui"],
      states: [
        {
          "#meta": { index: 0 },
          ui: "error",
          log: [
            { kind: "start", op: "-" },
            { kind: "reject", op: "A" },
            { kind: "fulfil", op: "A" },
            { kind: "reject", op: "B" },
          ],
        },
      ],
    });
    const plan = compilePlan(trace, { name: "retry" });
    expect(plan.schedule).toEqual([
      { order: 0, rule: "A", outcome: "reject", occurrence: 0 },
      { order: 1, rule: "A", outcome: "pass", occurrence: 1 },
      { order: 2, rule: "B", outcome: "reject", occurrence: 0 },
    ]);
  });

  it("lifts a call count into expect.calls, which no state probe could report", () => {
    // `expect.state` is compared against the bridge's stateProbe — something
    // the page or its server can report. "How many times was this endpoint
    // called" is not such an observable, so it needs its own field, compared
    // against what the fault layers counted.
    const trace = parseItfTrace({
      vars: ["log", "ui", "listCalls", "shown"],
      states: [
        {
          "#meta": { index: 0 },
          ui: "error",
          listCalls: { "#bigint": "2" },
          shown: { "#bigint": "0" },
          log: [
            { kind: "fulfil", op: "list" },
            { kind: "reject", op: "note" },
          ],
        },
      ],
    });
    const plan = compilePlan(trace, {
      name: "write-rejected",
      stateVars: ["shown"],
      callsVars: { list: "listCalls" },
    });
    expect(plan.expect.calls).toEqual({ list: 2 });
    expect(plan.expect.state).toEqual({ shown: 0 });
    // The schedule still describes only occurrence 0 — the reconcile read is
    // app behaviour, not an injection point. That gap between "what a fault
    // can target" and "how many calls there are" is the whole reason the field
    // exists.
    expect(plan.schedule.filter((step) => step.rule === "list")).toHaveLength(1);
  });

  it("forwards every compile option through compilePlansFromTraces", () => {
    // Regression: that function used to restate CompilePlanOptions by hand, so
    // `callsVars` was accepted by the CLI, typechecked (a spread argument
    // suppresses excess-property checking) and then dropped — a bound nobody
    // applied. The type is derived now; this pins it.
    const dir = mkdtempSync(join(tmpdir(), "chaosbringer-compile-"));
    try {
      writeFileSync(
        join(dir, "write-rejected.itf.json"),
        JSON.stringify({
          vars: ["log", "ui", "listCalls"],
          states: [
            {
              "#meta": { index: 0 },
              ui: "error",
              listCalls: { "#bigint": "2" },
              log: [
                { kind: "fulfil", op: "list" },
                { kind: "reject", op: "note" },
              ],
            },
          ],
        }),
      );
      const [plan] = compilePlansFromTraces([join(dir, "write-rejected.itf.json")], {
        callsVars: { list: "listCalls" },
      });
      expect(plan!.expect.calls).toEqual({ list: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a call count that is not a non-negative integer", () => {
    const trace = parseItfTrace({
      vars: ["log", "listCalls"],
      states: [
        {
          "#meta": { index: 0 },
          listCalls: "two",
          log: [{ kind: "reject", op: "note" }],
        },
      ],
    });
    expect(() => compilePlan(trace, { name: "bad", callsVars: { list: "listCalls" } })).toThrow(
      /must be a non-negative integer/,
    );
    expect(() => compilePlan(trace, { name: "bad", callsVars: { list: "nope" } })).toThrow(
      /not in the trace's final state/,
    );
  });

  it("refuses an unmapped model action rather than dropping it silently", () => {
    const trace = parseItfTrace({
      vars: ["log"],
      states: [{ "#meta": { index: 0 }, log: [{ kind: "corruptDisk", op: "A" }] }],
    });
    expect(() => compilePlan(trace)).toThrow(/no outcome mapping/);
  });

  it("refuses a log entry with no operation id", () => {
    const trace = parseItfTrace({
      vars: ["log"],
      states: [{ "#meta": { index: 0 }, log: [{ kind: "reject" }] }],
    });
    expect(() => compilePlan(trace)).toThrow(/carries no operation id/);
  });

  it("falls back to mbt metadata when the model has no log variable", () => {
    const plan = compilePlan(parseItfTrace(fixture("mbt.itf.json")), {
      name: "from-mbt",
      logVar: "absent",
    });
    // init/start are ignored; the remaining actions become steps.
    expect(plan.schedule.length).toBeGreaterThan(0);
    for (const step of plan.schedule) expect(["A", "B"]).toContain(step.rule);
  });
});

describe("markOrderSensitivePlans", () => {
  const base = (name: string, ui: string): FaultPlan => ({
    name,
    schedule: [
      { order: 0, rule: "A", outcome: "reject", occurrence: 0 },
      { order: 1, rule: "B", outcome: "reject", occurrence: 0 },
    ],
    expect: { ui },
  });

  it("flags plans with identical injections but different predictions", () => {
    const marked = markOrderSensitivePlans([base("ab", "error"), base("ba", "partial")]);
    expect(marked.every((p) => p.orderSensitive)).toBe(true);
  });

  it("leaves agreeing plans alone", () => {
    const marked = markOrderSensitivePlans([base("ab", "error"), base("ba", "error")]);
    expect(marked.some((p) => p.orderSensitive)).toBe(false);
  });

  it("keys by plan identity, so a name collision is not a verdict", () => {
    // Names come from filenames, unique within a directory — but `runPlans`
    // takes a flat array and nothing stops a caller merging two plan dirs.
    // Keyed by name, the third plan here was flagged too, on the strength of
    // sharing a string with a pair it has nothing to do with.
    const clash: FaultPlan[] = [
      { ...base("dup", "error") },
      { ...base("dup", "partial") },
      {
        name: "dup",
        schedule: [{ order: 0, rule: "Z", outcome: "status", occurrence: 0 }],
        expect: { ui: "ready" },
      },
    ];
    const out = markOrderSensitivePlans(clash);
    expect(out.map((p) => p.orderSensitive ?? false)).toEqual([true, true, false]);
  });

  it("leaves distinct injection sets alone", () => {
    const other: FaultPlan = {
      name: "hang",
      schedule: [{ order: 0, rule: "A", outcome: "hang", occurrence: 0 }],
      expect: { ui: "stuck" },
    };
    const marked = markOrderSensitivePlans([base("ab", "error"), other]);
    expect(marked.some((p) => p.orderSensitive)).toBe(false);
  });

  it("flags a disagreement that lives only in expect.state", () => {
    // The observable the shipped patterns assert on. `expectationKey` read
    // `ui` and `unhandledRejection` only, so "one order" versus "two orders"
    // from the same injections was replayed as if it were deterministic —
    // a coin flip presented as a verdict rather than a skipped plan.
    const withState = (name: string, orders: number): FaultPlan => ({
      ...base(name, "placed"),
      expect: { ui: "placed", state: { orders } },
    });
    const marked = markOrderSensitivePlans([withState("one", 1), withState("two", 2)]);
    expect(marked.every((p) => p.orderSensitive)).toBe(true);
  });

  it("flags a disagreement that lives only in expect.calls", () => {
    const withCalls = (name: string, calls: number): FaultPlan => ({
      ...base(name, "ready"),
      expect: { ui: "ready", calls: { A: calls } },
    });
    const marked = markOrderSensitivePlans([withCalls("one", 1), withCalls("two", 2)]);
    expect(marked.every((p) => p.orderSensitive)).toBe(true);
  });

  it("is insensitive to key order in a state expectation", () => {
    // Otherwise two plans that agree would be skipped as a coin flip, which
    // is the same bug pointing the other way.
    const marked = markOrderSensitivePlans([
      { ...base("a", "placed"), expect: { ui: "placed", state: { orders: 1, tries: 2 } } },
      { ...base("b", "placed"), expect: { ui: "placed", state: { tries: 2, orders: 1 } } },
    ]);
    expect(marked.some((p) => p.orderSensitive)).toBe(false);
  });
});

describe("validatePlan", () => {
  it("rejects two outcomes for one occurrence", () => {
    expect(() =>
      validatePlan({
        name: "dup",
        schedule: [
          { order: 0, rule: "A", outcome: "reject", occurrence: 0 },
          { order: 1, rule: "A", outcome: "hang", occurrence: 0 },
        ],
        expect: {},
      }),
    ).toThrow(/two outcomes to A@0/);
  });

  it("rejects a call count that is not a non-negative integer", () => {
    const plan = (calls: Record<string, number>): FaultPlan => ({
      name: "calls",
      schedule: [{ order: 0, rule: "A", outcome: "pass", occurrence: 0 }],
      expect: { calls },
    });
    expect(() => validatePlan(plan({ A: -1 }))).toThrow(/non-negative integer/);
    expect(() => validatePlan(plan({ A: 1.5 }))).toThrow(/non-negative integer/);
    expect(() => validatePlan(plan({ A: 0 }))).not.toThrow();
  });

  it("accepts a call count on an operation the schedule never pins", () => {
    // It used to be refused as unattributable, and that was the weaker
    // reading: `compilePlanFaults` gives such an operation a counting-only
    // rule, so `{ refresh: 0 }` on a control plan — "and this endpoint is
    // never touched at all" — is compared like any other count instead of
    // being rejected at the door.
    expect(() =>
      validatePlan({
        name: "counted-but-unpinned",
        schedule: [{ order: 0, rule: "A", outcome: "pass", occurrence: 0 }],
        expect: { calls: { B: 0 } },
      }),
    ).not.toThrow();
  });

  it("rejects an unknown outcome", () => {
    expect(() =>
      validatePlan({
        name: "bad",
        schedule: [{ order: 0, rule: "A", outcome: "explode" as never, occurrence: 0 }],
        expect: {},
      }),
    ).toThrow(/unknown outcome/);
  });
});

describe("compilePlanFaults", () => {
  const rules = { A: /\/api\/a$/, B: /\/api\/b$/ };

  it("emits one scheduled fault per (rule, outcome) with aligned decision tables", () => {
    const { runtimeFaults, faultInjection, expectedInjections } = compilePlanFaults(
      {
        name: "retry-then-hang",
        schedule: [
          { order: 0, rule: "A", outcome: "reject", occurrence: 0 },
          { order: 1, rule: "A", outcome: "pass", occurrence: 1 },
          { order: 2, rule: "A", outcome: "hang", occurrence: 2 },
        ],
        expect: {},
      },
      rules,
    );
    expect(faultInjection).toHaveLength(0);
    const reject = runtimeFaults.find((f) => f.name === faultNameFor("A", "reject"))!;
    const hang = runtimeFaults.find((f) => f.name === faultNameFor("A", "hang"))!;
    // Both tables span all three occurrences, so occurrence 2 means the same
    // call to both faults.
    expect(reject.schedule!.decisions).toEqual(["inject", "pass", "pass"]);
    expect(hang.schedule!.decisions).toEqual(["pass", "pass", "inject"]);
    expect(hang.action.kind).toBe("never-settle-fetch");
    expect(expectedInjections.get("A:reject")).toBe(1);
  });

  it("routes `status` through the network layer and rejections through the runtime layer", () => {
    const { runtimeFaults, faultInjection } = compilePlanFaults(
      {
        name: "mixed-rules",
        schedule: [
          { order: 0, rule: "A", outcome: "status", occurrence: 0 },
          { order: 1, rule: "B", outcome: "abort", occurrence: 0 },
        ],
        expect: {},
      },
      rules,
      503,
    );
    expect(faultInjection).toHaveLength(1);
    expect(faultInjection[0]!.fault).toEqual({ kind: "status", status: 503 });
    expect(runtimeFaults[0]!.action).toMatchObject({ kind: "reject-fetch", rejectAs: "AbortError" });
  });

  it("refuses to mix layers on one operation (occurrence counters would desync)", () => {
    expect(() =>
      compilePlanFaults(
        {
          name: "layer-mix",
          schedule: [
            { order: 0, rule: "A", outcome: "status", occurrence: 0 },
            { order: 1, rule: "A", outcome: "reject", occurrence: 1 },
          ],
          expect: {},
        },
        rules,
      ),
    ).toThrow(/mixes network- and runtime-layer outcomes/);
  });

  it("names the missing rule when a plan references an unmapped operation", () => {
    expect(() =>
      compilePlanFaults(
        {
          name: "unmapped",
          schedule: [{ order: 0, rule: "Z", outcome: "reject", occurrence: 0 }],
          expect: {},
        },
        rules,
      ),
    ).toThrow(/operation "Z" with no entry/);
  });
});

describe("coverage", () => {
  const result = (
    name: string,
    overrides: Partial<PlanRunResult> = {},
  ): PlanRunResult => ({
    plan: { name, schedule: [], expect: {} },
    observed: { unhandledRejection: false, lateUnhandledRejection: false, fired: {}, matched: {} },
    mismatches: [],
    ...overrides,
  });

  it("counts runs, skips and unexercised plans separately", () => {
    const coverage = aggregateCoverage([
      result("ok"),
      result("skipped", { skipped: "order-sensitive" }),
      result("never-called", {
        mismatches: [
          {
            plan: "never-called",
            field: "injection",
            expected: 1,
            actual: 0,
            detail: "A:reject was scheduled 1x but fired 0x",
          },
        ],
      }),
    ]);
    expect(coverage.plansRun).toBe(2);
    expect(coverage.plansSkipped).toBe(1);
    expect(coverage.plansNotExercised).toEqual(["never-called"]);
    expect(modelRunPassed(coverage)).toBe(false);
  });

  it("uses the enumeration's target rows when given, including unreachable ones", () => {
    const coverage = aggregateCoverage([result("a"), result("b")], {
      depthBound: 5,
      targets: [
        { target: 'ui == "error"', plan: "a", status: "reachable" },
        { target: 'ui == "done"', plan: "b", status: "reachable" },
        { target: 'ui == "done" and unhandled', status: "unreachable" },
      ],
    });
    expect(coverage.statesTargeted).toBe(3);
    // Named for what it counts: what the *enumerator* found reachable. The
    // skipped plan below still contributes, which is exactly why the old name
    // (`statesReached`) was wrong.
    expect(coverage.statesReachable).toBe(2);
    expect(coverage.statesUnreachableInBound).toBe(1);
    expect(formatModelCoverage(coverage)).toContain("depth <= 5");
  });

  it("passes only when nothing needs a human", () => {
    expect(modelRunPassed(aggregateCoverage([result("ok")]))).toBe(true);
  });

  it("does not pass a run of zero plans", () => {
    // No plans means no mismatches, which is not the same as verified.
    const empty = aggregateCoverage([]);
    expect(empty.plansRun).toBe(0);
    expect(modelRunPassed(empty)).toBe(false);
    expect(formatModelCoverage(empty)).toMatch(/No plans ran/);
  });

  it("pairs plans that share a coverage fingerprint", () => {
    const pairs = findCollapsedPlans(
      new Map([
        ["a", "sig1"],
        ["b", "sig1"],
        ["c", "sig2"],
      ]),
    );
    expect(pairs).toEqual([["a", "b"]]);
  });
});

describe("resolvePlanTiming", () => {
  const MEASURED = { delayFloorMs: 4, delayTailMs: 59, tightTailMs: 36, fixedPerPlanMs: 696 };

  it("keeps the historical behaviour when no app deadline is given", () => {
    // No declared deadline means nothing to derive from, so the observation
    // window falls back to the one number the author did commit to.
    expect(resolvePlanTiming({})).toEqual({ settleMs: 500, quiescenceMs: 500 });
    expect(resolvePlanTiming({ settleMs: 1600 })).toEqual({ settleMs: 1600, quiescenceMs: 1600 });
    // …and an explicit 0 opts out of the second read entirely.
    expect(resolvePlanTiming({ settleMs: 400, quiescenceMs: 0 })).toEqual({
      settleMs: 400,
      quiescenceMs: 0,
    });
  });

  it("solves the settle window and the timing delays from the profile", () => {
    const t = resolvePlanTiming({ appDeadlineMs: 5000, timingProfile: MEASURED });
    expect(t.settleMs).toBe(5097);
    // The post-probe window is one more app-bounded round, same arithmetic.
    expect(t.quiescenceMs).toBe(5097);
    // slowMs outlasts the probe, not merely the deadline: settle 5097 + 25 - 4.
    expect(t.delays).toEqual({ fastMs: 4857, slowMs: 5190 });
    // The navigation timeout survives the slowest delay a plan can put on a
    // load-time request (fixed 696 + slow 5190 + tail 118 + margin 25); the
    // probe is not bounded by it at all.
    expect(t.solved?.pageTimeoutMs).toBe(6029);
    expect(t.pageTimeoutMs).toBe(6029);
    // …and the wall clock counts both windows, which is what a plan spends.
    expect(t.wallClockMs).toBe(10890); // 696 + 5097 + 5097
  });

  it("re-derives the navigation timeout from a declared window, not the solved one", () => {
    // The bug shape already fixed one field over for the tripping delay: a
    // bridge that declares settleMs got a page timeout solved for a window it
    // is not using, and `runPlan` forwarded that number to the crawler.
    const t = resolvePlanTiming({ settleMs: 12000, appDeadlineMs: 600, timingProfile: MEASURED });
    expect(t.settleMs).toBe(12000);
    // Declared window + tight + margin - floor — the same separation the solved
    // path uses. Deriving it as `declared + margin - floor` would give a
    // declaring bridge the 22ms probe gap back, which is the whole bug.
    expect(t.delays!.slowMs).toBe(12093);
    expect(t.pageTimeoutMs).toBe(696 + 12093 + 118 + 25);
    // The solved solution still answers for the *solved* window, so the two
    // are visibly different numbers rather than one silently wrong one.
    expect(t.solved!.pageTimeoutMs).toBe(696 + 790 + 118 + 25);
  });

  it("checks a declared per-plan budget against both windows", () => {
    // `budgetMs` is documented as the wall clock the operator will tolerate,
    // so it is compared against fixed + settle + quiesce. 6000 covers the old
    // (probe-only) figure of 5793 and not the 10890 a plan really costs.
    // The solver rejects it outright — `within_budget` is one of its own
    // constraints — and the message carries the arithmetic.
    expect(() =>
      resolvePlanTiming({ appDeadlineMs: 5000, timingProfile: MEASURED, budgetMs: 6000 }),
    ).toThrow(/within_budget/);
    expect(() =>
      resolvePlanTiming({ appDeadlineMs: 5000, timingProfile: MEASURED, budgetMs: 6000 }),
    ).toThrow(/one plan costs ~10890ms/);
    expect(
      resolvePlanTiming({ appDeadlineMs: 5000, timingProfile: MEASURED, budgetMs: 11000 }).settleMs,
    ).toBe(5097);
  });

  it("refuses a settle window that cannot decide anything", () => {
    // The configuration this repo actually shipped by hand.
    expect(() =>
      resolvePlanTiming({ settleMs: 1200, appDeadlineMs: 5000, timingProfile: MEASURED }),
    ).toThrow(/cannot decide anything against a 5000ms app deadline/);
  });

  it("makes the remedy the infeasibility error names actually reachable", () => {
    // The error says: "lower the safety factor if your calibration is
    // trustworthy". It offered three remedies and this was the only one a
    // bridge could not perform — `safety` lived on `TimingRequest` and nothing
    // forwarded it. An error naming an unreachable fix is worse than an error
    // naming none, because the reader spends time looking for the knob.
    const infeasible = { appDeadlineMs: 120, timingProfile: MEASURED };
    expect(() => resolvePlanTiming(infeasible)).toThrow(/lower the safety factor/);

    // Same deadline, same profile, safety 1: the tails are the measurement
    // rather than twice it, so 120ms becomes expressible.
    const t = resolvePlanTiming({ ...infeasible, safety: 1 });
    expect(t.solved!.profile.safety).toBe(1);
    expect(t.solved!.profile.tightTailMs).toBe(MEASURED.tightTailMs); // not doubled
    // …and the separation the flake was about still scales with it.
    expect(t.delays!.slowMs).toBeGreaterThan(t.settleMs + MEASURED.tightTailMs);
  });

  it("accepts a hand-written window that is generous enough", () => {
    const t = resolvePlanTiming({ settleMs: 6000, appDeadlineMs: 5000, timingProfile: MEASURED });
    expect(t.settleMs).toBe(6000);
    // …and still exposes the solved delays, so timing plans work — but the
    // tripping delay is re-derived from the *declared* window, not the solved
    // one. 5190ms would land 810ms before this probe, and against an app with
    // no bound at all (the thing a timing plan is trying to detect) a response
    // that lands before the probe reads as healthy.
    expect(t.delays?.slowMs).toBe(6093); // declared 6000 + tight 72 + margin 25 - floor 4
    // Strictly later than the probe *including* the probe's own overshoot —
    // `> settleMs` alone was satisfied by the 22ms gap that flaked.
    expect(t.delays!.slowMs).toBeGreaterThan(t.settleMs + MEASURED.tightTailMs * 2);
  });

  it("refuses an observation window too short to see the app's own follow-up", () => {
    expect(() =>
      resolvePlanTiming({ quiescenceMs: 200, appDeadlineMs: 5000, timingProfile: MEASURED }),
    ).toThrow(/quiescenceMs=200 cannot outlast one more 5000ms round/);
    // …and 0 is a deliberate opt-out, not a mistake to be corrected.
    expect(
      resolvePlanTiming({ quiescenceMs: 0, appDeadlineMs: 5000, timingProfile: MEASURED })
        .quiescenceMs,
    ).toBe(0);
  });

  it("refuses a deadline this environment cannot resolve at all", () => {
    expect(() => resolvePlanTiming({ appDeadlineMs: 120, timingProfile: MEASURED })).toThrow(
      /no timing values can satisfy an app deadline of 120ms/,
    );
  });

  it("checks the crawler timeout against navigation, which is what it bounds", () => {
    // It used to be passed through as `budgetMs` and compared against
    // `pageTimeoutMs`, i.e. a wall-clock claim measured against a navigation
    // number. Both halves are checked now, each against its own quantity: a
    // 3000ms navigation timeout cannot survive the 5190ms delay a plan may
    // inject into a load-time request.
    expect(() =>
      resolvePlanTiming({ appDeadlineMs: 5000, timingProfile: MEASURED, timeout: 3000 }),
    ).toThrow(/fits_navigation_timeout/);
    expect(() =>
      resolvePlanTiming({ appDeadlineMs: 5000, timingProfile: MEASURED, timeout: 3000 }),
    ).toThrow(/navigation needs 6029ms to survive a 5190ms injected delay/);
    // A timeout that does survive it is accepted and forwarded unchanged.
    expect(
      resolvePlanTiming({ appDeadlineMs: 5000, timingProfile: MEASURED, timeout: 9000 }).settleMs,
    ).toBe(5097);
  });

  it("refuses an app deadline that is not a number", () => {
    // `appDeadlineMs: Number(process.env.APP_DEADLINE)` with the variable
    // unset. Before, this solved `sat` with every field NaN and the run
    // reached `page.waitForTimeout(NaN)`.
    expect(() =>
      resolvePlanTiming({ appDeadlineMs: Number.NaN, timingProfile: MEASURED }),
    ).toThrow(/inputs_well_formed/);
    expect(() => resolvePlanTiming({ appDeadlineMs: 0, timingProfile: MEASURED })).toThrow(
      /deadlineMs must be greater than 0/,
    );
  });

  describe("an app that retries: the window has to outlast the ladder", () => {
    // F7. `appDeadlineMs` describes one request; a client with a budget of
    // three reaches its terminal state three rounds and two backoffs later,
    // and the window solved for one round reports it as an endless spinner.
    const ladder = { attempts: 3, backoffsMs: [60, 120] };

    it("refuses a window that only covers one round", () => {
      expect(() =>
        resolvePlanTiming({ settleMs: 700, appDeadlineMs: 500, appLadder: ladder, timingProfile: MEASURED }),
      ).toThrow(/settle_outlasts_app_ladder/);
    });

    it("accepts one that covers the whole ladder", () => {
      const t = resolvePlanTiming({
        settleMs: 3000,
        appDeadlineMs: 500,
        appLadder: ladder,
        timingProfile: MEASURED,
      });
      // 3 x (500 + 72 + 25) + 180 = 1971, so 3000 is enough.
      expect(t.settleMs).toBe(3000);
      // A declared window moves the probe, so "too slow" is re-derived from
      // it: a delay solved for the 597ms probe would land mid-window and an
      // unbounded app would read as healthy.
      expect(t.delays!.slowMs).toBe(3093); // declared 3000 + tight 72 + margin 25 - floor 4
      expect(t.delays!.slowMs).toBeGreaterThan(t.settleMs + MEASURED.tightTailMs * 2);
    });

    it("names the number to write when the ladder is declared without a window", () => {
      expect(() =>
        resolvePlanTiming({ appDeadlineMs: 500, appLadder: ladder, timingProfile: MEASURED }),
      ).toThrow(/terminal state is 1971ms away.*Set settleMs to at least 1971/s);
    });

    it("refuses a ladder that cannot describe an app", () => {
      expect(() => resolvePlanTiming({ appDeadlineMs: 500, appLadder: { attempts: 0, backoffsMs: [] } })).toThrow(
        /attempts must be a positive integer/,
      );
      expect(() =>
        resolvePlanTiming({ appDeadlineMs: 500, appLadder: { attempts: 2, backoffsMs: [60, 120] } }),
      ).toThrow(/at most attempts-1 waits/);
      expect(() => resolvePlanTiming({ appLadder: ladder })).toThrow(/appLadder needs appDeadlineMs/);
    });
  });
});

describe("validateCallCountRules", () => {
  // F2. A `$`-anchored rule under `expect.calls` is not a narrow selector, it
  // is a wrong number: the resume request carrying `?cursor=…` is neither
  // faulted nor counted, so 58 requests can be reported as the 9 the model
  // predicted.
  const plan = {
    name: "budget-exhausted",
    schedule: [{ order: 0, rule: "stream", outcome: "reject" as const, occurrence: 0 }],
    expect: { calls: { stream: 3 } },
  };

  it("refuses the anchored pattern and names the fix", () => {
    expect(() => validateCallCountRules(plan, { stream: /\/api\/stream$/ })).toThrow(
      /expect\.calls on operation "stream".*Widen it to \/\\\/api\\\/stream\(\\\?\|\$\)\//s,
    );
    // …including through the object form, where the pattern is one field.
    expect(() =>
      validateCallCountRules(plan, { stream: { urlPattern: /\/api\/stream$/, methods: ["GET"] } }),
    ).toThrow(/\$`-anchored pattern/);
  });

  it("accepts a pattern that can see a query string", () => {
    expect(() => validateCallCountRules(plan, { stream: /\/api\/stream(\?|$)/ })).not.toThrow();
    // An escaped dollar is a literal, not an anchor.
    expect(() => validateCallCountRules(plan, { stream: /\/api\/stream\$/ })).not.toThrow();
    // An unanchored string is fine, in either spelling.
    expect(() => validateCallCountRules(plan, { stream: "/api/stream" })).not.toThrow();
    expect(() => validateCallCountRules(plan, { stream: "/api/stream(\\?|$)" })).not.toThrow();
  });

  it("refuses the string spelling of the same anchor", () => {
    // `UrlMatcher = string | RegExp` and every layer compiles the string with
    // `new RegExp(m)`, so `"/api/stream$"` *is* `/\/api\/stream$/` — and
    // `new RegExp("/api/stream$").test("/api/stream?cursor=3") === false`
    // exactly as for the RegExp. A pre-flight that fires for one of two
    // equivalent spellings is a lint a user routes around by accident.
    expect(new RegExp("/api/stream$").test("/api/stream?cursor=3")).toBe(false);
    expect(() => validateCallCountRules(plan, { stream: "/api/stream$" })).toThrow(
      /expect\.calls on operation "stream"/,
    );
    // The fix is echoed in the spelling the author actually wrote — a string,
    // not a regex literal they never typed.
    expect(() => validateCallCountRules(plan, { stream: "/api/stream$" })).toThrow(
      /Widen it to "\/api\/stream\(\\\\\?\|\$\)"/,
    );
    // …and through the object form too.
    expect(() =>
      validateCallCountRules(plan, { stream: { urlPattern: "/api/stream$", methods: ["GET"] } }),
    ).toThrow(/\$`-anchored pattern/);
    // A string that is not a valid pattern is left to the layer that compiles
    // it for real, rather than crashing the pre-flight.
    expect(() => validateCallCountRules(plan, { stream: "/api/stream($" })).not.toThrow();
  });

  it("leaves an anchored rule alone when no plan counts it", () => {
    // Everywhere else the regex is a selector, and narrow is the author's
    // business — `pagination-order` anchors `?page=1$` on purpose.
    expect(() =>
      validateCallCountRules(
        { name: "p", schedule: [], expect: { ui: "ready" } },
        { page1: /\/api\/feed\?page=1$/ },
      ),
    ).not.toThrow();
  });
});

describe("model run's coverage assembly", () => {
  const plan = (name: string): FaultPlan => ({
    name,
    spec: "cart.qnt",
    schedule: [{ order: 0, rule: "cart", outcome: "reject", occurrence: 0 }],
    expect: {},
  });
  const result = (name: string, fingerprint?: string) => ({
    plan: plan(name),
    observed: {
      unhandledRejection: false,
      lateUnhandledRejection: false,
      fired: {},
      matched: {},
      ...(fingerprint !== undefined ? { coverageFingerprint: fingerprint } : {}),
    },
    mismatches: [],
  });

  it("hands the collected fingerprints to aggregateCoverage", () => {
    // `model run` collected a V8 coverage digest per plan and then dropped it,
    // so `collapsedPlans` was unconditionally empty for every CLI user no
    // matter what the bridge asked for. The digests being collected is not the
    // claim; the report naming the collapsed pair is.
    const plans = [plan("reject-first"), plan("reject-second")];
    const coverage = coverageForRun(plans, [
      result("reject-first", "sha256:aaa"),
      result("reject-second", "sha256:aaa"),
    ]);
    expect(coverage.collapsedPlans).toEqual([["reject-first", "reject-second"]]);
    expect(coverage.spec).toBe("cart.qnt");
  });

  it("stays empty when no fingerprints were collected", () => {
    const coverage = coverageForRun([plan("a")], [result("a")]);
    expect(coverage.collapsedPlans).toEqual([]);
  });
});

describe("nextDrainWaitMs", () => {
  // The drain exists to wait out the app's *own* follow-up work — a `void
  // retry()` inside a 900ms backoff. Which timer it waits for decides whether
  // it costs what it drains or costs the whole cap.
  it("waits for the latest timer that fits, not the latest and not the earliest", () => {
    // Both extremes are wrong, in opposite directions.
    //
    // Latest regardless: a page with a 200ms retry and a 300s session-refresh
    // timer spends `min(300025, 3000)` = the entire cap and comes back with
    // that timer still pending — measured at +3097ms per plan of pure sleep on
    // a page whose only far timer was irrelevant.
    //
    // Earliest: it advances one timer per round, so four ordinary timers ahead
    // of an interesting one exhaust the loop and the interesting one never
    // runs. That shipped, and it turned an escaping rejection into a clean
    // run — the one output this tool must never produce.
    const decoysThenTheInterestingOne = {
      timers: 5,
      intervals: 0,
      earliestDueInMs: 150,
      latestDueInMs: 900,
      dueInMs: [150, 300, 450, 600, 900],
    };
    expect(nextDrainWaitMs(decoysThenTheInterestingOne, 3000)).toBe(925);

    // …and when the far one does not fit, the answer is the latest that does,
    // so the decoys still drain instead of the round being wasted on 150ms.
    const withASessionTimer = {
      timers: 6,
      intervals: 0,
      earliestDueInMs: 150,
      latestDueInMs: 300000,
      dueInMs: [150, 300, 450, 600, 900, 300000],
    };
    expect(nextDrainWaitMs(withASessionTimer, 3000)).toBe(925);
  });

  it("stops instead of sleeping when nothing pending fits the budget", () => {
    // The whole defect in one case: one `setTimeout(fn, 300000)` and nothing
    // else. There is nothing to drain inside the cap, so the answer is to
    // stop — the timer is reported in `observed.pendingAsync`, not slept on.
    expect(
      nextDrainWaitMs(
        { timers: 1, intervals: 0, earliestDueInMs: 295328, latestDueInMs: 295328, dueInMs: [295328] },
        3000,
      ),
    ).toBeNull();
    // Reading a page that predates the `dueInMs` field falls back to the
    // earliest, which is the safe direction: it under-drains rather than
    // over-sleeping.
    expect(
      nextDrainWaitMs({ timers: 1, intervals: 0, earliestDueInMs: 295328 }, 3000),
    ).toBeNull();
    // Exactly on the boundary is still worth waiting for; one ms over is not.
    expect(nextDrainWaitMs({ timers: 1, intervals: 0, earliestDueInMs: 2975 }, 3000)).toBe(3000);
    expect(nextDrainWaitMs({ timers: 1, intervals: 0, earliestDueInMs: 2976 }, 3000)).toBeNull();
  });

  it("stops when nothing is pending or the cap is spent", () => {
    expect(nextDrainWaitMs({ timers: 0, intervals: 0 }, 3000)).toBeNull();
    expect(nextDrainWaitMs({ timers: 1, intervals: 0, earliestDueInMs: 10 }, 0)).toBeNull();
    expect(nextDrainWaitMs({ timers: 1, intervals: 0, earliestDueInMs: 10 }, -5)).toBeNull();
  });

  it("never waits less than the callback needs to actually run", () => {
    // A timer already due reads as 0 or negative; the +25 is what makes the
    // difference between "became due" and "ran".
    expect(nextDrainWaitMs({ timers: 1, intervals: 0, earliestDueInMs: 0 }, 3000)).toBe(25);
    expect(nextDrainWaitMs({ timers: 1, intervals: 0, earliestDueInMs: -40 }, 3000)).toBe(25);
  });
});

describe("aggregateCoverage: a plan whose bridge threw", () => {
  it("counts a probeError as not exercised", () => {
    // `probeError` suppresses the derived checks, so the `injection` mismatch
    // that normally carries "the app never issued that request" is absent —
    // and `plansNotExercised` was keyed on that field alone. The effect was a
    // broken bridge reporting a state as reached by a run whose action never
    // ran, in the one field whose docstring says it answers "did a run
    // actually get there".
    const threw = aggregateCoverage([
      {
        plan: { name: "checkout-retry", schedule: [], expect: {} },
        mismatches: [
          {
            plan: "checkout-retry",
            field: "probeError" as const,
            detail: 'locator.click: Timeout 30000ms exceeded waiting for locator("#submitt")',
          },
        ],
        observed: { matched: {}, lateUnhandledRejection: false, fired: {} },
      },
    ] as unknown as Parameters<typeof aggregateCoverage>[0]);
    expect(threw.plansNotExercised).toEqual(["checkout-retry"]);
    expect(modelRunPassed(threw)).toBe(false);
  });
});

describe("drainScheduledWork", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A page whose timers actually elapse. `waitForTimeout` advances a virtual
   * clock and anything due by then "runs" — enough to test the loop, which is
   * the part that had no test and the part that broke: `nextDrainWaitMs` was
   * unit-tested in isolation while the loop around it silently capped at four
   * rounds.
   */
  function fakePage(dueAtMs: readonly number[]) {
    let now = 0;
    const waits: number[] = [];
    const page = {
      waitForTimeout: async (ms: number) => {
        waits.push(ms);
        now += ms;
        // The drain budgets itself against the wall clock, so a fake that only
        // advanced its own timers would let it loop for free — which is
        // exactly what the first version of this helper did, and it reported a
        // 50-second drain as if the cap did not exist. Advance both.
        vi.setSystemTime(new Date(Date.now() + ms));
      },
      evaluate: async () => {
        const due = dueAtMs.filter((d) => d > now).map((d) => d - now).sort((a, b) => a - b);
        return due.length > 0
          ? {
              timers: due.length,
              intervals: 0,
              earliestDueInMs: due[0],
              latestDueInMs: due[due.length - 1],
              dueInMs: due,
            }
          : { timers: 0, intervals: 0 };
      },
    };
    return { page: page as unknown as Parameters<typeof drainScheduledWork>[0], waits, elapsed: () => now };
  }

  it("drains a timer sitting behind four ordinary ones", async () => {
    // The regression, as a test. A debounce, a toast, an analytics flush and a
    // focus restore, then the `void retry()` whose rejection is the whole
    // reason the drain exists. A four-round loop that advanced to the earliest
    // timer each round returned here with the 900ms one still pending and
    // reported "no rejection escaped".
    const { page, elapsed } = fakePage([150, 300, 450, 600, 900]);
    const pending = await drainScheduledWork(page, 3000);
    expect(pending.timers).toBe(0);
    expect(elapsed()).toBeLessThan(1000); // one wait, not four rounds of sleeping
  });

  it("does not sleep out the cap for a timer that cannot arrive", async () => {
    // The cost defect the round-bound was introduced to fix, still fixed: a
    // 300s session timer and nothing else means there is nothing to drain.
    const { page, waits } = fakePage([300000]);
    const pending = await drainScheduledWork(page, 3000);
    expect(waits).toEqual([]);
    expect(pending.timers).toBe(1);
    expect(pending.latestDueInMs).toBe(300000);
  });

  it("drains what fits and reports what does not", async () => {
    const { page, elapsed } = fakePage([200, 500, 300000]);
    const pending = await drainScheduledWork(page, 3000);
    expect(pending.timers).toBe(1); // the session timer
    expect(elapsed()).toBeLessThan(600);
  });

  it("follows a chain of timers that each schedule the next", async () => {
    // Re-arming is why this iterates at all. Four rounds was enough for this
    // case and not enough for the one above, which is what made the round
    // count look adequate.
    const { page } = fakePage([100, 250, 400, 550, 700, 850, 1000]);
    expect((await drainScheduledWork(page, 3000)).timers).toBe(0);
  });

  it("stops at the cap rather than following a poller forever", async () => {
    // A recursive `setTimeout(poll, 100)` cannot be drained, only bounded.
    const poller = Array.from({ length: 500 }, (_, i) => (i + 1) * 100);
    const { page, elapsed } = fakePage(poller);
    const pending = await drainScheduledWork(page, 3000);
    expect(elapsed()).toBeLessThanOrEqual(3000);
    expect(pending.timers).toBeGreaterThan(0); // reported, not failed on
  });
});

describe("timing outcomes", () => {
  const rules = { cart: /\/api\/cart$/ };

  it("realises slow-ok and slow-trip as delays from the solved timing", () => {
    const plan: FaultPlan = {
      name: "slow-cart",
      schedule: [
        { order: 0, rule: "cart", outcome: "slow-ok", occurrence: 0 },
        { order: 1, rule: "cart", outcome: "slow-trip", occurrence: 1 },
      ],
      expect: {},
    };
    const { faultInjection } = compilePlanFaults(plan, rules, 500, { fastMs: 457, slowMs: 693 });
    const ok = faultInjection.find((f) => f.name === faultNameFor("cart", "slow-ok"))!;
    const trip = faultInjection.find((f) => f.name === faultNameFor("cart", "slow-trip"))!;
    expect(ok.fault).toEqual({ kind: "delay", ms: 457 });
    expect(trip.fault).toEqual({ kind: "delay", ms: 693 });
    // Same rule, so the two decision tables must span the same occurrences.
    expect(ok.schedule!.decisions).toEqual(["inject", "pass"]);
    expect(trip.schedule!.decisions).toEqual(["pass", "inject"]);
  });

  it("refuses to invent a millisecond value when timing was not solved", () => {
    const plan: FaultPlan = {
      name: "slow-cart",
      schedule: [{ order: 0, rule: "cart", outcome: "slow-ok", occurrence: 0 }],
      expect: {},
    };
    expect(() => compilePlanFaults(plan, rules)).toThrow(/no portable millisecond value/);
  });

  it("maps the model's timing action names", () => {
    const trace = parseItfTrace({
      vars: ["log", "ui"],
      states: [
        {
          "#meta": { index: 0 },
          ui: "ready",
          log: [
            { kind: "slow", op: "cart" },
            { kind: "tooSlow", op: "shipping" },
          ],
        },
      ],
    });
    expect(compilePlan(trace, { name: "t" }).schedule.map((s) => s.outcome)).toEqual([
      "slow-ok",
      "slow-trip",
    ]);
  });
});

describe("calibration envelope", () => {
  const run = (delayMax: number, tightMax: number, fixed: number): CalibrationRun => ({
    delay: [
      { nominal: 0, observedMin: 4, observedMax: 4 + delayMax, overheadMin: 4, overheadMax: delayMax },
      { nominal: 20, observedMin: 26, observedMax: 26, overheadMin: 6, overheadMax: 6 },
    ],
    tight: [{ nominal: 200, observedMin: 200, observedMax: 200 + tightMax, overheadMin: 0, overheadMax: tightMax }],
    fixedPerPlanMs: fixed,
  });

  it("takes floors at their min and tails at their max across runs", () => {
    // A warm run under-reports the tail; the envelope must not.
    const prof = envelope([run(14, 3, 650), run(107, 36, 700), run(15, 5, 680)]);
    expect(prof.delayFloorMs).toBe(4);
    expect(prof.delayTailMs).toBe(107);
    expect(prof.tightTailMs).toBe(36);
    expect(prof.fixedPerPlanMs).toBe(700);
    expect(prof.runs).toBe(3);
  });

  it("refuses to aggregate nothing", () => {
    expect(() => envelope([])).toThrow(/no calibration runs/);
  });

  it("clamps a negative measured floor rather than writing an unusable profile", () => {
    // Real output from a calibration run under 4-way CPU contention:
    // `delayFloorMs: -101`. `overheadMin` is `observed - nominal`, so a
    // negative value means the noise is larger than the quantity — not a
    // mechanism that answers before it was asked. Left alone it makes
    // `slow = settle + margin - floor` grow without bound and
    // `fast >= floor` unfalsifiable, and `solveTiming` refuses the profile
    // outright (`inputs_well_formed`), so `model calibrate` would write a
    // file that no plan can be solved against.
    const noisy: CalibrationRun = {
      delay: [
        { nominal: 300, observedMin: 199, observedMax: 366, overheadMin: -101, overheadMax: 66 },
      ],
      tight: [{ nominal: 200, observedMin: 200, observedMax: 252, overheadMin: 0, overheadMax: 52 }],
      fixedPerPlanMs: 741,
    };
    const prof = envelope([noisy]);
    expect(prof.delayFloorMs).toBe(0);
    // …and the profile it writes is one the solver will accept.
    expect(solveTiming(prof, { deadlineMs: 700 }).status).toBe("sat");
  });
});



describe("compilePlanFaults: observing a plan that injects nothing", () => {
  const rules = { A: /\/api\/a$/, B: /\/api\/b$/ };

  it("counts the calls an all-`pass` plan claims will happen", () => {
    const { faultInjection, runtimeFaults, expectedInjections, expectedObservations, ruleOfFault } =
      compilePlanFaults(
        {
          name: "happy",
          schedule: [
            { order: 0, rule: "A", outcome: "pass", occurrence: 0 },
            { order: 1, rule: "A", outcome: "pass", occurrence: 1 },
            { order: 2, rule: "B", outcome: "pass", occurrence: 0 },
          ],
          expect: { ui: "ready" },
        },
        rules,
      );
    // Nothing is injected — that is the point — but every request is counted.
    expect(expectedInjections.size).toBe(0);
    expect(runtimeFaults).toHaveLength(0);
    expect(expectedObservations.get("A")).toBe(2);
    expect(expectedObservations.get("B")).toBe(1);
    const counter = faultInjection.find((f) => f.name === observationNameFor("A"))!;
    // All-`pass` decisions: the crawler advances the occurrence counter and
    // falls through, so the page behaves exactly as if the rule were absent.
    expect(counter.schedule!.decisions).toEqual(["pass", "pass"]);
    expect(counter.schedule!.afterEnd).toBe("pass");
    expect(ruleOfFault.get(observationNameFor("A"))).toBe("A");
  });

  it("counts a pass-only rule even when a sibling injects, but requires nothing of it", () => {
    // Two different questions with two different answers.
    //
    // Requiring the call is unsound here: an injected failure can legitimately
    // stop the app from issuing a later request (`await a; await b` never
    // reaches b), so demanding that b was called would flag the model's own
    // prediction as a bug.
    //
    // *Counting* it is not only sound but necessary — without a route there is
    // no `matched` for B, and an `expect.calls` bound naming it would be
    // accepted and then never enforced.
    const { expectedObservations, faultInjection } = compilePlanFaults(
      {
        name: "mixed",
        schedule: [
          { order: 0, rule: "A", outcome: "reject", occurrence: 0 },
          { order: 1, rule: "B", outcome: "pass", occurrence: 0 },
        ],
        expect: {},
      },
      rules,
    );
    expect(expectedObservations.size).toBe(0);
    expect(faultInjection).toHaveLength(1);
    expect(faultInjection[0]!.name).toBe(observationNameFor("B"));
    // Behaviourally neutral: nothing but `pass`, so `route.fallback()` runs
    // for it exactly as if the rule were absent.
    expect(faultInjection[0]!.schedule).toEqual({ decisions: ["pass"], afterEnd: "pass" });
  });

  it("counts an operation named only by expect.calls, so a zero is enforceable", () => {
    // token-refresh's both-tokens-fresh control says calls.refresh = 0. With
    // no route nothing counts the refresh endpoint, `matched.refresh` comes
    // back undefined and the oracle skips the comparison — so the strongest
    // claim a control plan makes would be the one thing nobody checked.
    const { faultInjection, expectedObservations, ruleOfFault } = compilePlanFaults(
      {
        name: "no-refresh",
        schedule: [{ order: 0, rule: "me", outcome: "pass", occurrence: 0 }],
        expect: { calls: { refresh: 0 } },
      },
      { me: /\/api\/me$/, refresh: { urlPattern: /\/api\/refresh(\?|$)/, methods: ["POST"] } },
    );
    const counting = faultInjection.find((f) => f.name === observationNameFor("refresh"))!;
    expect(counting).toBeDefined();
    expect(counting.methods).toEqual(["POST"]);
    // Nothing is pinned, so nothing is decided: every request falls through
    // and is counted on the way past.
    expect(counting.schedule).toEqual({ decisions: ["pass"], afterEnd: "pass" });
    expect(ruleOfFault.get(observationNameFor("refresh"))).toBe("refresh");
    // …and the call is counted, never *required*: nothing was injected that
    // could have prevented it, and the model says it must not happen at all.
    expect(expectedObservations.has("refresh")).toBe(false);
  });

  it("names the missing rule when only expect.calls mentions it", () => {
    expect(() =>
      compilePlanFaults(
        {
          name: "no-rule",
          schedule: [{ order: 0, rule: "me", outcome: "pass", occurrence: 0 }],
          expect: { calls: { refresh: 0 } },
        },
        { me: /\/api\/me$/ },
      ),
    ).toThrow(/expects calls on operation "refresh" with no entry in `rules`/);
  });

  it("keeps the method filter, so a counting rule cannot claim a sibling verb", () => {
    const { faultInjection } = compilePlanFaults(
      {
        name: "write-only",
        schedule: [{ order: 0, rule: "post", outcome: "pass", occurrence: 0 }],
        expect: {},
      },
      { post: { urlPattern: /\/api\/todos$/, methods: ["POST"] } },
    );
    expect(faultInjection[0]!.methods).toEqual(["POST"]);
  });
});

describe("evaluatePlanOracle", () => {
  const base = (over: Partial<PlanOracleInput> = {}): PlanOracleInput => ({
    plan: { name: "p", schedule: [], expect: {} },
    observed: {
      unhandledRejection: false,
      lateUnhandledRejection: false,
      fired: {},
      matched: {},
    },
    expectedInjections: new Map(),
    expectedObservations: new Map(),
    hasUiProbe: true,
    hasStateProbe: true,
    settleMs: 500,
    quiescenceMs: 500,
    ...over,
  });
  const fields = (input: PlanOracleInput): string[] =>
    evaluatePlanOracle(input).map((m) => m.field).sort();

  describe("an all-`pass` plan has to be observed, not merely not-failed", () => {
    const plan = {
      name: "happy",
      schedule: [{ order: 0, rule: "cart", outcome: "pass" as const, occurrence: 0 }],
      expect: { ui: "ready" },
    };

    it("reports the operation the app never called", () => {
      const mismatches = evaluatePlanOracle(
        base({
          plan,
          observed: {
            ui: "ready",
            unhandledRejection: false,
            lateUnhandledRejection: false,
            fired: {},
            matched: { cart: 0 },
          },
          expectedObservations: new Map([["cart", 1]]),
        }),
      );
      expect(mismatches.map((m) => m.field)).toEqual(["injection"]);
      // `injection` on purpose: that is what `plansNotExercised` is keyed on,
      // so a vacuous happy path stops counting as a reached state.
      expect(aggregateCoverage([{ plan, observed: base().observed, mismatches }]).plansNotExercised)
        .toEqual(["happy"]);
      expect(mismatches[0]!.detail).toMatch(/asserted only a label/);
    });

    it("says nothing when the call actually happened", () => {
      expect(
        fields(
          base({
            plan,
            observed: {
              ui: "ready",
              unhandledRejection: false,
              lateUnhandledRejection: false,
              fired: {},
              matched: { cart: 1 },
            },
            expectedObservations: new Map([["cart", 1]]),
          }),
        ),
      ).toEqual([]);
    });
  });

  describe("amplification", () => {
    const plan = {
      name: "beat",
      schedule: [{ order: 0, rule: "telemetry", outcome: "status" as const, occurrence: 0 }],
      expect: {},
    };
    const observed = (matched: number) => ({
      unhandledRejection: false,
      lateUnhandledRejection: false,
      fired: { "telemetry:status": 1 },
      matched: { telemetry: matched },
    });

    it("is silent by default, however many calls were made", () => {
      // Not a false negative by accident: a model written for one user action
      // against a page that also fetches on load legitimately sees more
      // requests than its schedule names, and failing that would be noise.
      expect(fields(base({ plan, observed: observed(12) }))).toEqual([]);
    });

    it("reports calls past the schedule's span once asked to", () => {
      const mismatches = evaluatePlanOracle(
        base({ plan, observed: observed(12), checkAmplification: true }),
      );
      expect(mismatches.map((m) => m.field)).toEqual(["amplification"]);
      expect(mismatches[0]).toMatchObject({ expected: 1, actual: 12 });
    });

    it("tolerates exactly as many calls as the plan describes", () => {
      expect(fields(base({ plan, observed: observed(1), checkAmplification: true }))).toEqual([]);
      const twoStep = {
        name: "two",
        schedule: [
          { order: 0, rule: "telemetry", outcome: "pass" as const, occurrence: 0 },
          { order: 1, rule: "telemetry", outcome: "status" as const, occurrence: 1 },
        ],
        expect: {},
      };
      expect(
        fields(base({ plan: twoStep, observed: observed(2), checkAmplification: true })),
      ).toEqual([]);
    });

    it("checks `expect.calls` always, exactly, and in the direction it happened", () => {
      const stated = { ...plan, expect: { calls: { telemetry: 1 } } };
      expect(fields(base({ plan: stated, observed: observed(12) }))).toEqual(["amplification"]);
      expect(fields(base({ plan: stated, observed: observed(1) }))).toEqual([]);
      // Too *few* is a finding as well: the model said the beacon fires. But
      // it is not `amplification` — that field is documented as "more calls
      // than the model described", and a consumer switching on it exhaustively
      // would be told the exact opposite of what happened. An under-count is
      // the `injection` class: the app didn't make a call the model states.
      const under = evaluatePlanOracle(base({ plan: stated, observed: observed(0) }));
      expect(under.map((m) => m.field)).toEqual(["injection"]);
      expect(under[0]).toMatchObject({ expected: 1, actual: 0 });
      expect(under[0]!.detail).toMatch(/the app made 0/);
      // …and it does not claim to know which of the two causes it was.
      expect(under[0]!.detail).toMatch(/or an outcome injected earlier in this plan/);
    });

    it("reports a rule nothing counted as undecided, not as satisfied", () => {
      // `compilePlanFaults` always installs a counting route, so `matched`
      // normally has an entry. If the crawl dies before the routes go on, the
      // stats arrays are absent — and treating a missing count as "no news"
      // turns an asserted number into a pass. An unmeasured assertion is not
      // a satisfied one.
      const stated = { ...plan, expect: { calls: { telemetry: 1 } } };
      const out = evaluatePlanOracle(
        base({
          plan: stated,
          observed: {
            unhandledRejection: false,
            lateUnhandledRejection: false,
            fired: {},
            matched: {},
          },
        }),
      );
      expect(out.map((m) => m.field)).toEqual(["undecided"]);
      expect(out[0]!.detail).toMatch(/nothing counted requests on operation "telemetry"/);
    });
  });

  describe("a broken bridge is not a finding about the app", () => {
    // A typo'd selector: `locator.click` times out, `observed.probeError` is
    // set, and nothing after the throw ran. Every derived check then reads
    // observations that were never made — and the `injection` message used to
    // state, in the library's own confident prose, that *the app* never issued
    // the request.
    const plan = {
      name: "checkout",
      schedule: [{ order: 0, rule: "write", outcome: "reject" as const, occurrence: 0 }],
      expect: { ui: "error", state: { orders: 1 }, calls: { write: 1 }, unhandledRejection: false },
    };
    const broken = base({
      plan,
      observed: {
        unhandledRejection: false,
        lateUnhandledRejection: false,
        fired: {},
        matched: {},
        probeError: 'locator.click: Timeout 30000ms exceeded waiting for locator("#submitt")',
      },
      expectedInjections: new Map([["write:reject", 1]]),
      uiInvariantFailures: [{ key: "*", message: "no #total on the page" }],
    });

    it("reports the throw as itself and suppresses everything derived from it", () => {
      const out = evaluatePlanOracle(broken);
      expect(out.map((m) => m.field)).toEqual(["probeError"]);
      expect(out[0]!.actual).toMatch(/#submitt/);
      expect(out[0]!.detail).toMatch(/decided nothing about the app/);
      // The four findings this plan would otherwise have produced, none of
      // which is evidence of anything.
      expect(out.map((m) => m.field)).not.toContain("injection");
      expect(out.map((m) => m.field)).not.toContain("state");
      expect(out.map((m) => m.field)).not.toContain("ui");
      expect(out.map((m) => m.field)).not.toContain("uiInvariant");
    });

    it("still fails the run — a broken bridge is not a pass", () => {
      const mismatches = evaluatePlanOracle(broken);
      const coverage = aggregateCoverage([{ plan, observed: broken.observed, mismatches }]);
      expect(modelRunPassed(coverage)).toBe(false);
      // …and the plan *is* filed as not exercised. The first version of this
      // asserted the opposite, on the reasoning that "the planned fault never
      // fired" is a claim about the app — true of the *wording*, and wrong
      // about the field: `plansNotExercised` is what answers "did a run
      // actually get there", and a run whose action threw did not. Leaving it
      // out let a broken bridge report a state as reached.
      expect(coverage.plansNotExercised).toEqual([plan.name]);
    });
  });

  describe("a run that could not decide is not a run that passed", () => {
    // The probe instant is the whole soundness argument for `slow-trip`: the
    // injected response lands at `trippingResponseAtMs`, and only a probe that
    // fires before it can tell an app that enforced its deadline from one with
    // no deadline at all. Under single-core contention a
    // `page.waitForTimeout(731)` overshoots its 21ms of headroom easily.
    const plan = {
      name: "report-tooSlow",
      schedule: [{ order: 0, rule: "report", outcome: "slow-trip" as const, occurrence: 0 }],
      expect: { ui: "error" },
    };
    const observed = (ui: string) => ({
      ui,
      unhandledRejection: false,
      lateUnhandledRejection: false,
      fired: { "report:slow-trip": 1 },
      matched: { report: 1 },
    });

    it("refuses to call an unbounded app healthy when the probe fired too late", () => {
      const out = evaluatePlanOracle(
        base({
          plan,
          observed: observed("error"),
          settleMs: 731,
          probeElapsedMs: 760,
          trippingResponseAtMs: 756, // slow 752 + delayFloor 4
        }),
      );
      // The label matched the model — and means nothing, because the response
      // had already landed. Reported as undecided instead of as a pass.
      expect(out.map((m) => m.field)).toEqual(["undecided"]);
      expect(out[0]!.detail).toMatch(/began reading at 760ms/);
      expect(out[0]!.detail).toMatch(/tightTailMs/);
    });

    it("suppresses the ui verdict rather than narrating it from a bad instant", () => {
      const out = evaluatePlanOracle(
        base({
          plan,
          observed: observed("ready"),
          settleMs: 731,
          probeElapsedMs: 900,
          trippingResponseAtMs: 756,
        }),
      );
      // "predicted error, got ready" would be the right field for the wrong
      // reason: on this run "ready" is what a *correct* app looks like too.
      expect(out.map((m) => m.field)).toEqual(["undecided"]);
    });

    it("says nothing when the probe was early enough, in either direction", () => {
      const early = { settleMs: 731, probeElapsedMs: 740, trippingResponseAtMs: 756 };
      expect(fields(base({ plan, observed: observed("error"), ...early }))).toEqual([]);
      expect(fields(base({ plan, observed: observed("ready"), ...early }))).toEqual(["ui"]);
    });

    it("only applies to plans whose verdict depends on that instant", () => {
      // A plan with no tripping delay has no such window, so a late probe is
      // not a reason to refuse a verdict.
      const noTiming = {
        name: "write-rejected",
        schedule: [{ order: 0, rule: "write", outcome: "reject" as const, occurrence: 0 }],
        expect: { ui: "error" },
      };
      expect(
        fields(
          base({
            plan: noTiming,
            observed: observed("ready"),
            settleMs: 731,
            probeElapsedMs: 5000,
            trippingResponseAtMs: 756,
          }),
        ),
      ).toEqual(["ui"]);
    });
  });

  describe("state is judged on the settled read", () => {
    const plan = {
      name: "order-once",
      schedule: [{ order: 0, rule: "order", outcome: "reject-body" as const, occurrence: 0 }],
      expect: { state: { orders: 1 } },
    };

    it("catches a duplicate write that commits after the probe", () => {
      const mismatches = evaluatePlanOracle(
        base({
          plan,
          observed: {
            unhandledRejection: false,
            lateUnhandledRejection: false,
            fired: { "order:reject-body": 1 },
            matched: { order: 2 },
            state: { orders: 1 },
            stateSettled: { orders: 2 },
          },
          expectedInjections: new Map([["order:reject-body", 1]]),
        }),
      );
      expect(mismatches.map((m) => m.field)).toEqual(["state"]);
      expect(mismatches[0]).toMatchObject({ expected: 1, actual: 2 });
      // The detail has to name both reads, or the failure looks like a flake.
      expect(mismatches[0]!.detail).toMatch(/read 1 at settleMs=500/);
      expect(mismatches[0]!.detail).toMatch(/2 500ms later/);
    });

    it("does not report a slow-but-correct commit", () => {
      // Probe too early, settled read right: a 202-Accepted backend, not a
      // bug. Failing this is how the second read would turn into a flake
      // generator on every queue-backed API.
      expect(
        fields(
          base({
            plan,
            observed: {
              unhandledRejection: false,
              lateUnhandledRejection: false,
              fired: { "order:reject-body": 1 },
              matched: {},
              state: { orders: 0 },
              stateSettled: { orders: 1 },
            },
            expectedInjections: new Map([["order:reject-body", 1]]),
          }),
        ),
      ).toEqual([]);
    });

    it("falls back to the probe read when no window was spent", () => {
      expect(
        fields(
          base({
            plan,
            quiescenceMs: 0,
            observed: {
              unhandledRejection: false,
              lateUnhandledRejection: false,
              fired: {},
              matched: {},
              state: { orders: 2 },
            },
          }),
        ),
      ).toEqual(["state"]);
    });

    it("still refuses an expectation the bridge cannot read", () => {
      const mismatches = evaluatePlanOracle(base({ plan, hasStateProbe: false }));
      expect(mismatches.map((m) => m.field)).toEqual(["state"]);
      expect(mismatches[0]!.detail).toMatch(/unchecked expectation is worse than none/);
    });
  });

  describe("a rejection that escaped after the probe", () => {
    const plan = {
      name: "late",
      schedule: [{ order: 0, rule: "quote", outcome: "reject" as const, occurrence: 0 }],
      expect: { unhandledRejection: false },
    };

    it("gets its own field, so it is not confused with one that raced the probe", () => {
      const mismatches = evaluatePlanOracle(
        base({
          plan,
          observed: {
            unhandledRejection: true,
            lateUnhandledRejection: true,
            fired: { "quote:reject": 1 },
            matched: { quote: 1 },
          },
          expectedInjections: new Map([["quote:reject", 1]]),
          settleMs: 400,
        }),
      );
      expect(mismatches.map((m) => m.field)).toEqual(["unhandledRejection@late"]);
      expect(mismatches[0]!.detail).toMatch(/stopped watching at settleMs=400/);
    });

    it("keeps the plain field for one that was already there", () => {
      expect(
        fields(
          base({
            plan,
            observed: {
              unhandledRejection: true,
              lateUnhandledRejection: false,
              fired: {},
              matched: {},
            },
          }),
        ),
      ).toEqual(["unhandledRejection"]);
    });

    it("still reports a predicted rejection that never came", () => {
      const mismatches = evaluatePlanOracle(
        base({
          plan: { ...plan, expect: { unhandledRejection: true } },
          observed: {
            unhandledRejection: false,
            lateUnhandledRejection: false,
            fired: {},
            matched: {},
          },
        }),
      );
      expect(mismatches.map((m) => m.field)).toEqual(["unhandledRejection"]);
    });
  });

  describe("the label is read again after the window", () => {
    // F4: `ui` and `uiInvariants` used to be read at exactly one instant, so a
    // `Promise.race` "timeout" — which bounds the banner and cancels nothing —
    // passed every rung and then rendered the report it claimed to have given
    // up on, 400ms after the only look the oracle took.
    const plan = {
      name: "report-tooSlow",
      schedule: [{ order: 0, rule: "report", outcome: "slow-trip" as const, occurrence: 0 }],
      expect: { ui: "error" },
    };
    const seen = (over: Partial<PlanRunResult["observed"]>) => ({
      unhandledRejection: false,
      lateUnhandledRejection: false,
      fired: { "report:slow-trip": 1 },
      matched: { report: 1 },
      ...over,
    });

    it("reports a label that was right at the probe and moved afterwards", () => {
      const mismatches = evaluatePlanOracle(
        base({
          plan,
          observed: seen({ ui: "error", uiSettled: "ready" }),
          expectedInjections: new Map([["report:slow-trip", 1]]),
          settleMs: 731,
          quiescenceMs: 731,
        }),
      );
      expect(mismatches.map((m) => m.field)).toEqual(["ui@late"]);
      expect(mismatches[0]).toMatchObject({ expected: "error", actual: "ready" });
      expect(mismatches[0]!.detail).toMatch(/predicted ui="error" at settleMs=731/);
      expect(mismatches[0]!.detail).toMatch(/moved to "ready" 731ms later/);
    });

    it("does not report a label that started wrong and converged", () => {
      // The same soundness rule the settled state read follows: a spinner
      // resolving into the predicted state is a page catching up, and failing
      // it would make every slow render a mismatch. One `ui` mismatch, with
      // the convergence named in the detail — not two.
      const mismatches = evaluatePlanOracle(
        base({
          plan,
          observed: seen({ ui: "stuck", uiSettled: "error" }),
          expectedInjections: new Map([["report:slow-trip", 1]]),
        }),
      );
      expect(mismatches.map((m) => m.field)).toEqual(["ui"]);
      expect(mismatches[0]!.detail).toMatch(/still catching up/);
    });

    it("says nothing when the label held", () => {
      expect(fields(base({ plan, observed: seen({ ui: "error", uiSettled: "error" }) }))).toEqual(
        [],
      );
    });

    it("reports an invariant that only broke during the window", () => {
      const mismatches = evaluatePlanOracle(
        base({
          plan: { name: "feed", schedule: [], expect: { ui: "ready" } },
          observed: seen({ ui: "ready", uiSettled: "ready" }),
          uiInvariantFailuresLate: [{ key: "*", message: "rows are out of order: 3,4,1,2" }],
          settleMs: 400,
          quiescenceMs: 900,
        }),
      );
      expect(mismatches.map((m) => m.field)).toEqual(["uiInvariant@late"]);
      expect(mismatches[0]!.detail).toMatch(/held at settleMs=400 and stopped holding 900ms later/);
    });

    it("reports an invariant that was already broken exactly once", () => {
      // Same key at both reads is one finding, not two: a doubled report makes
      // a single bug look like a spreading one.
      const mismatches = evaluatePlanOracle(
        base({
          plan: { name: "feed", schedule: [], expect: { ui: "ready" } },
          observed: seen({ ui: "ready", uiSettled: "ready" }),
          uiInvariantFailures: [{ key: "*", message: "rows are out of order" }],
          uiInvariantFailuresLate: [{ key: "*", message: "rows are out of order" }],
        }),
      );
      expect(mismatches.map((m) => m.field)).toEqual(["uiInvariant"]);
    });
  });

  it("reports a label whose own invariant does not hold", () => {
    const mismatches = evaluatePlanOracle(
      base({
        plan: { name: "quote", schedule: [], expect: { ui: "error" } },
        observed: {
          ui: "error",
          unhandledRejection: false,
          lateUnhandledRejection: false,
          fired: {},
          matched: {},
        },
        uiInvariantFailures: [{ key: "error", message: "#pay is still enabled" }],
      }),
    );
    // The label matched the model exactly; what it promises did not.
    expect(mismatches.map((m) => m.field)).toEqual(["uiInvariant"]);
    expect(mismatches[0]!.detail).toMatch(/ui="error".*"error" invariant does not hold/);
  });
});

describe("checkUiInvariants", () => {
  const page = {} as never;

  it("runs the wildcard and the label's own, and nothing else", () => {
    const seen: string[] = [];
    const invariants = {
      "*": () => {
        seen.push("*");
        return "";
      },
      error: () => {
        seen.push("error");
        return "stale summary";
      },
      ready: () => {
        seen.push("ready");
        return "should not run";
      },
    };
    return checkUiInvariants(page, "error", invariants).then((out) => {
      expect(seen).toEqual(["*", "error"]);
      expect(out).toEqual([{ key: "error", message: "stale summary" }]);
    });
  });

  it("treats an empty string, null and undefined as passing", async () => {
    expect(
      await checkUiInvariants(page, "ready", {
        "*": () => "",
        ready: () => null,
      }),
    ).toEqual([]);
    expect(await checkUiInvariants(page, "ready", { ready: () => undefined })).toEqual([]);
  });

  it("reports a throwing invariant instead of failing the run", async () => {
    const out = await checkUiInvariants(page, "ready", {
      ready: () => {
        throw new Error("locator not found");
      },
    });
    expect(out).toEqual([{ key: "ready", message: "invariant threw: locator not found" }]);
  });

  it("runs the wildcard even with no ui probe, and nothing at all without invariants", async () => {
    expect(await checkUiInvariants(page, undefined, { "*": () => "always wrong" })).toEqual([
      { key: "*", message: "always wrong" },
    ]);
    expect(await checkUiInvariants(page, "ready", undefined)).toEqual([]);
  });
});
