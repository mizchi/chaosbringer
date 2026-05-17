/**
 * Reusable rubric primitives. Each returns a `RubricCriterion`. Compose them
 * in scenarios to keep rubric definitions short and consistent across
 * scenarios.
 *
 * Designed to be testable on transcript strings alone — no live agent
 * needed to verify the rubric works.
 */
import type { RubricCriterion, ScoringContext, ScenarioReport, CriterionVerdict } from "./types.ts";

/**
 * Did the agent inspect telemetry / state / source BEFORE editing code?
 * Real on-calls who skip diagnosis cause more incidents than they fix.
 */
export function investigatedBeforeEditing(weight = 3): RubricCriterion {
  return {
    id: "investigate-before-edit",
    description: "Inspected logs / source / metrics before editing any code",
    weight,
    failHint: "Edited code before reading anything. Investigate first.",
    check: ({ toolUses }) => {
      const firstEdit = toolUses.findIndex((t) => t.name === "Edit" || t.name === "Write");
      if (firstEdit === -1) return false; // no edit attempted
      const investigative = toolUses.slice(0, firstEdit).filter((t) =>
        ["Read", "Grep", "Glob", "Bash"].includes(t.name),
      );
      return investigative.length >= 2;
    },
  };
}

/** Did the agent check the chaos-stats endpoint / runtime kumo state? */
export function checkedKumoChaosStats(weight = 2): RubricCriterion {
  return {
    id: "checked-chaos-stats",
    description: "Queried kumo /kumo/chaos/stats or /rules to see what is being injected",
    weight,
    failHint: "Did not check kumo chaos endpoints. The runtime state of injected faults is the fastest path to identifying the upstream.",
    check: ({ toolUses }) =>
      toolUses.some(
        (t) =>
          t.name === "Bash" &&
          /\/kumo\/chaos\/(rules|stats)/.test(t.input),
      ),
  };
}

/** Did the agent read the application source? */
export function readTargetSource(weight = 2): RubricCriterion {
  return {
    id: "read-target-source",
    description: "Read the target app source before changing it",
    weight,
    failHint: "Edited target without reading it first.",
    check: ({ toolUses }) =>
      toolUses.some((t) => t.name === "Read" && t.input.includes("target/")),
  };
}

/** Did the SLO actually recover? Outcome criterion (small weight by default). */
export function recoveredSlo(weight = 5): RubricCriterion {
  return {
    id: "recovered-slo",
    description: "Probe SLO returned to acceptance criteria during recovery window",
    weight,
    failHint: "SLO never recovered. Mitigation did not work.",
    check: ({ drillReport }) => drillReport.recovered,
  };
}

/** Did the agent avoid adding MORE retries (the 2015 DDB anti-pattern)? */
export function didNotAddRetries(weight = 3): RubricCriterion {
  return {
    id: "no-extra-retries",
    description: "Did not increase SDK retry attempts (anti-pattern for retry-storm incidents)",
    weight,
    failHint: "Added more retries. This makes retry-storm-driven outages worse, not better.",
    check: ({ transcript }) =>
      !/maxAttempts:\s*[5-9]\d*|maxAttempts:\s*1\d+|retryAttempts:\s*[5-9]\d*/i.test(transcript),
  };
}

/** Did the agent change too much code (large diff vs. minimal fix)? */
export function minimalCodeChange(maxEditSites = 3, weight = 2): RubricCriterion {
  return {
    id: "minimal-change",
    description: `Made a focused change (≤ ${maxEditSites} edit/write tool uses)`,
    weight,
    failHint: "Too many edits across the codebase — recovery should be a focused intervention.",
    check: ({ toolUses }) =>
      toolUses.filter((t) => t.name === "Edit" || t.name === "Write").length <= maxEditSites,
  };
}

/** Did the agent at any point form a verbal hypothesis about the root cause? */
export function statedHypothesis(weight = 2): RubricCriterion {
  return {
    id: "stated-hypothesis",
    description: "Stated an explicit hypothesis before acting",
    weight,
    failHint: "Acted without an explicit hypothesis.",
    check: ({ transcript }) =>
      /\b(hypothesis|i think|likely|probably|the cause|root cause|because)\b/i.test(transcript),
  };
}

// ---- driver ----------------------------------------------------------------

/**
 * scoreScenario evaluates the rubric against an agent run.
 *
 * Pure function over (transcript, drillReport, toolUses) — can be re-run
 * with an updated rubric on a saved transcript.
 */
export function scoreScenario(ctx: ScoringContext): ScenarioReport {
  const criteria: CriterionVerdict[] = ctx.scenario.rubric.map((c) => ({
    id: c.id,
    description: c.description,
    passed: c.check(ctx),
    weight: c.weight,
    failHint: c.failHint,
  }));

  const totalWeight = criteria.reduce((s, c) => s + c.weight, 0);
  const passedWeight = criteria.filter((c) => c.passed).reduce((s, c) => s + c.weight, 0);
  const score = totalWeight === 0 ? 0 : passedWeight / totalWeight;

  const redHerringsHit: string[] = [];
  for (const r of ctx.scenario.redHerrings ?? []) {
    if (new RegExp(r.matchKeyword, "i").test(ctx.transcript)) {
      redHerringsHit.push(r.hypothesis);
    }
  }

  return {
    scenarioId: ctx.scenario.id,
    passed: score >= 0.6 && ctx.drillReport.recovered,
    score,
    maxScore: 1,
    criteria,
    redHerringsHit,
    drillReport: ctx.drillReport,
    transcript: ctx.transcript,
    toolUses: ctx.toolUses,
    debrief: renderDebrief({ ...ctx, criteria, score, redHerringsHit }),
  };
}

interface DebriefInput extends ScoringContext {
  criteria: CriterionVerdict[];
  score: number;
  redHerringsHit: string[];
}

function renderDebrief(d: DebriefInput): string {
  const okMark = (b: boolean) => (b ? "PASS" : "FAIL");
  const lines: string[] = [];
  lines.push(`# Debrief: ${d.scenario.title}`);
  lines.push("");
  lines.push(`**Outcome:** ${d.drillReport.recovered ? "RECOVERED" : "did not recover within window"}`);
  lines.push(`**Score:** ${(d.score * 100).toFixed(0)}%`);
  lines.push("");
  lines.push("## Ground truth");
  lines.push(d.scenario.groundTruth);
  lines.push("");
  if (d.scenario.idealPath?.length) {
    lines.push("## Ideal investigation path");
    for (const step of d.scenario.idealPath) lines.push(`- ${step}`);
    lines.push("");
  }
  lines.push("## Rubric");
  for (const c of d.criteria) {
    lines.push(`- **[${okMark(c.passed)}]** ${c.description} _(weight ${c.weight})_`);
    if (!c.passed && c.failHint) lines.push(`    - ${c.failHint}`);
  }
  lines.push("");
  if (d.redHerringsHit.length) {
    lines.push("## Red herrings followed");
    for (const h of d.redHerringsHit) lines.push(`- ${h}`);
    lines.push("");
  }
  lines.push("## Phase-by-phase SLO");
  for (const phase of d.drillReport.injectedByPhase) {
    const ok = phase.samples.filter((s) => s.ok).length;
    const pct = phase.samples.length === 0 ? 0 : (ok / phase.samples.length) * 100;
    lines.push(`- **${phase.label}**: ${ok}/${phase.samples.length} OK (${pct.toFixed(0)}%)`);
  }
  const rOk = d.drillReport.recovery.filter((s) => s.ok).length;
  lines.push(`- **recovery**: ${rOk}/${d.drillReport.recovery.length} OK`);
  return lines.join("\n");
}
