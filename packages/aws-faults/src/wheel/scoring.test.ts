import { describe, expect, it } from "vitest";
import { scoreScenario } from "./scoring.ts";
import type { Scenario, ToolUseRecord } from "./types.ts";
import type { DrillReport } from "../orchestrator.ts";

function makeScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: "test",
    title: "test",
    initialAlert: "alert",
    groundTruth: "ground truth",
    drill: { id: "x", name: "x", description: "", healthCheck: async () => ({ ok: true, latencyMs: 1, errorRate: 0 }), acceptance: {} },
    rubric: [],
    ...overrides,
  };
}

function makeReport(recovered: boolean): DrillReport {
  return {
    drillId: "x",
    passed: recovered,
    baseline: [],
    injectedByPhase: [{ label: "peak", samples: [{ ok: false, latencyMs: 100, errorRate: 1 }] }],
    injected: [],
    recovery: [{ ok: true, latencyMs: 10, errorRate: 0 }],
    durationMs: 1000,
    recovered,
  };
}

describe("scoreScenario", () => {
  it("detects red herrings by case-insensitive keyword", () => {
    const scenario = makeScenario({
      redHerrings: [{ hypothesis: "blamed deploy", matchKeyword: "recent\\s+deploy" }],
      rubric: [],
    });
    const report = scoreScenario({
      scenario,
      drillReport: makeReport(true),
      transcript: "Maybe the recent deploy caused this.",
      toolUses: [],
    });
    expect(report.redHerringsHit).toEqual(["blamed deploy"]);
  });

  it("scores criteria by weight", () => {
    const scenario = makeScenario({
      rubric: [
        { id: "a", description: "always pass", weight: 2, check: () => true },
        { id: "b", description: "always fail", weight: 3, check: () => false },
      ],
    });
    const report = scoreScenario({
      scenario,
      drillReport: makeReport(true),
      transcript: "",
      toolUses: [],
    });
    expect(report.score).toBeCloseTo(0.4); // 2 of 5 weight
    expect(report.criteria.map((c) => c.passed)).toEqual([true, false]);
  });

  it("`investigate before editing` passes when 2+ read/grep precede first Edit", async () => {
    const { investigatedBeforeEditing } = await import("./scoring.ts");
    const c = investigatedBeforeEditing();
    const tu: ToolUseRecord[] = [
      { name: "Read", input: "a", atSec: 1 },
      { name: "Bash", input: "ls", atSec: 2 },
      { name: "Edit", input: "b", atSec: 3 },
    ];
    expect(c.check({ scenario: makeScenario(), drillReport: makeReport(true), transcript: "", toolUses: tu })).toBe(true);
  });

  it("`investigate before editing` fails when Edit comes first", async () => {
    const { investigatedBeforeEditing } = await import("./scoring.ts");
    const c = investigatedBeforeEditing();
    const tu: ToolUseRecord[] = [{ name: "Edit", input: "x", atSec: 1 }];
    expect(c.check({ scenario: makeScenario(), drillReport: makeReport(true), transcript: "", toolUses: tu })).toBe(false);
  });

  it("`didNotAddRetries` catches maxAttempts: 10", async () => {
    const { didNotAddRetries } = await import("./scoring.ts");
    const c = didNotAddRetries();
    expect(c.check({ scenario: makeScenario(), drillReport: makeReport(true), transcript: "client.maxAttempts: 10", toolUses: [] })).toBe(false);
    expect(c.check({ scenario: makeScenario(), drillReport: makeReport(true), transcript: "maxAttempts: 1", toolUses: [] })).toBe(true);
  });

  it("renders a markdown debrief", () => {
    const scenario = makeScenario({
      title: "Scenario Foo",
      idealPath: ["step 1", "step 2"],
      rubric: [{ id: "a", description: "did the thing", weight: 1, check: () => false, failHint: "do the thing" }],
    });
    const report = scoreScenario({
      scenario,
      drillReport: makeReport(false),
      transcript: "",
      toolUses: [],
    });
    expect(report.debrief).toContain("# Debrief: Scenario Foo");
    expect(report.debrief).toContain("**Outcome:** did not recover");
    expect(report.debrief).toContain("step 1");
    expect(report.debrief).toContain("[FAIL]");
    expect(report.debrief).toContain("do the thing");
  });
});
