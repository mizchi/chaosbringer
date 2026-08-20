import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { aggregateCoverage, findCollapsedPlans, formatModelCoverage, modelRunPassed } from "./coverage.js";
import { decodeItfValue, finalState, parseItfTrace, readBool, readString } from "./itf.js";
import { compilePlan, markOrderSensitivePlans, validatePlan, type FaultPlan } from "./plan.js";
import { compilePlanFaults, faultNameFor, type PlanRunResult } from "./runner.js";

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
    observed: { unhandledRejection: false, fired: {} },
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
