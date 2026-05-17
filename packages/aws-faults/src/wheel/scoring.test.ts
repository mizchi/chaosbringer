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

  it("`didNotAddRetries` catches several phrasings of 'more retries'", async () => {
    const { didNotAddRetries } = await import("./scoring.ts");
    const c = didNotAddRetries();
    const ctx = (t: string) => ({ scenario: makeScenario(), drillReport: makeReport(true), transcript: t, toolUses: [] });
    // FAIL when the agent added retries — multiple phrasings.
    expect(c.check(ctx("client.maxAttempts: 10"))).toBe(false);
    expect(c.check(ctx("maxAttempts to 8"))).toBe(false);     // eval3 case
    expect(c.check(ctx("max_attempts = 6"))).toBe(false);
    expect(c.check(ctx("Raised maxAttempts to 8"))).toBe(false);
    expect(c.check(ctx("app-level retry loop (10 attempts)"))).toBe(false);
    expect(c.check(ctx("retries=12 with exponential backoff"))).toBe(false);
    // PASS when retries are 1-4 or absent.
    expect(c.check(ctx("maxAttempts: 1"))).toBe(true);
    expect(c.check(ctx("Capped retries at 2"))).toBe(true);
    expect(c.check(ctx("added a circuit breaker, no retry changes"))).toBe(true);
  });

  it("red-herring detection respects negation in the same sentence", () => {
    const scenario = makeScenario({
      redHerrings: [{ hypothesis: "blamed SQS", matchKeyword: "sqs.*cause" }],
    });
    // Naive substring would hit; negation-aware should NOT.
    const r1 = scoreScenario({
      scenario,
      drillReport: makeReport(true),
      transcript: "The SQS warnings were cascading symptoms, not the primary cause.",
      toolUses: [],
    });
    expect(r1.redHerringsHit).toEqual([]);
    // A genuine red-herring chase should still be caught.
    const r2 = scoreScenario({
      scenario,
      drillReport: makeReport(true),
      transcript: "SQS is the cause of these failures — let me check the queues.",
      toolUses: [],
    });
    expect(r2.redHerringsHit).toEqual(["blamed SQS"]);
  });

  it("`rereadPageBoard` requires >=N reads of the page file", async () => {
    const { rereadPageBoard } = await import("./scoring.ts");
    const c = rereadPageBoard(2);
    const oneRead: ToolUseRecord[] = [{ name: "Read", input: "/tmp/wom/oncall-pages.txt", atSec: 1 }];
    const twoReads: ToolUseRecord[] = [
      { name: "Read", input: "/tmp/wom/oncall-pages.txt", atSec: 1 },
      { name: "Bash", input: "cat /tmp/wom/oncall-pages.txt", atSec: 30 },
    ];
    const ctx = (tu: ToolUseRecord[]) => ({
      scenario: makeScenario(),
      drillReport: makeReport(true),
      transcript: "",
      toolUses: tu,
    });
    expect(c.check(ctx(oneRead))).toBe(false);
    expect(c.check(ctx(twoReads))).toBe(true);
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
