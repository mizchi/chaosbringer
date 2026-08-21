import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { aggregateCoverage, findCollapsedPlans, formatModelCoverage, modelRunPassed } from "./coverage.js";
import { decodeItfValue, finalState, parseItfTrace, readBool, readString } from "./itf.js";
import { compilePlansFromTraces } from "./cli.js";
import { compilePlan, markOrderSensitivePlans, validatePlan, type FaultPlan } from "./plan.js";
import {
  checkUiInvariants,
  compilePlanFaults,
  evaluatePlanOracle,
  faultNameFor,
  observationNameFor,
  resolvePlanTiming,
  type PlanOracleInput,
  type PlanRunResult,
} from "./runner.js";
import { envelope, type CalibrationRun } from "./calibrate.js";

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

  it("rejects a call count on an operation the schedule never pins", () => {
    expect(() =>
      validatePlan({
        name: "unattributable",
        schedule: [{ order: 0, rule: "A", outcome: "pass", occurrence: 0 }],
        expect: { calls: { B: 1 } },
      }),
    ).toThrow(/schedule never mentions operation "B"/);
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
    expect(coverage.statesReached).toBe(2);
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
    expect(t.delays).toEqual({ fastMs: 4857, slowMs: 5118 });
    expect(t.solved?.pageTimeoutMs).toBe(5936);
  });

  it("refuses a settle window that cannot decide anything", () => {
    // The configuration this repo actually shipped by hand.
    expect(() =>
      resolvePlanTiming({ settleMs: 1200, appDeadlineMs: 5000, timingProfile: MEASURED }),
    ).toThrow(/cannot decide anything against a 5000ms app deadline/);
  });

  it("accepts a hand-written window that is generous enough", () => {
    const t = resolvePlanTiming({ settleMs: 6000, appDeadlineMs: 5000, timingProfile: MEASURED });
    expect(t.settleMs).toBe(6000);
    // …and still exposes the solved delays, so timing plans work.
    expect(t.delays?.slowMs).toBe(5118);
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

  it("treats the crawler timeout as the budget", () => {
    expect(() =>
      resolvePlanTiming({ appDeadlineMs: 5000, timingProfile: MEASURED, timeout: 3000 }),
    ).toThrow(/budget is too small/);
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

    it("checks `expect.calls` always, and exactly", () => {
      const stated = { ...plan, expect: { calls: { telemetry: 1 } } };
      expect(fields(base({ plan: stated, observed: observed(12) }))).toEqual(["amplification"]);
      expect(fields(base({ plan: stated, observed: observed(1) }))).toEqual([]);
      // Too *few* is a finding as well: the model said the beacon fires.
      expect(fields(base({ plan: stated, observed: observed(0) }))).toEqual(["amplification"]);
    });

    it("skips a rule nothing counted rather than guessing zero", () => {
      // An all-`pass` rule inside a plan that injects elsewhere has no
      // counter, so `matched` has no entry for it. Reading that as 0 would
      // turn a blind spot into a false failure.
      const stated = { ...plan, expect: { calls: { telemetry: 1 } } };
      expect(
        fields(
          base({
            plan: stated,
            observed: {
              unhandledRejection: false,
              lateUnhandledRejection: false,
              fired: {},
              matched: {},
            },
          }),
        ),
      ).toEqual([]);
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
