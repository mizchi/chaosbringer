/**
 * Model-state coverage: what the enumeration targeted, what actually ran,
 * and where model and implementation disagree.
 *
 * The point of the whole pipeline is a claim probability sweeps cannot make
 * — "these N states were exercised, these M are unreachable within depth k,
 * nothing else exists in the model". This module assembles that claim, and
 * is deliberately conservative about it: skipped plans, unfired injections,
 * and states the enumerator proved unreachable are all reported separately
 * rather than folded into a single percentage.
 */

import type { FaultPlan } from "./plan.js";
import type { PlanMismatch, PlanRunResult } from "./runner.js";

/** One row per target state the enumerator was asked about. */
export interface TargetOutcome {
  /** Predicate / state label, as written in the target list. */
  target: string;
  /** Plan that reaches it, when one was found. */
  plan?: string;
  /** `unreachable` = the checker found no witness within `depthBound`. */
  status: "reachable" | "unreachable";
}

export interface ModelCoverage {
  spec?: string;
  /** Bounded model checking depth the enumeration ran at. */
  depthBound?: number;
  statesTargeted: number;
  statesReached: number;
  statesUnreachableInBound: number;
  plansRun: number;
  plansSkipped: number;
  /** Plans that ran but whose planned faults never fired. */
  plansNotExercised: string[];
  mismatches: PlanMismatch[];
  /**
   * Plans the model calls distinct states but whose executed code was
   * identical (V8 coverage fingerprints matched). Either the model is
   * over-refined or the app does not actually distinguish the cases — both
   * are worth a human. Empty when coverage fingerprints weren't collected.
   */
  collapsedPlans: Array<[string, string]>;
}

export interface AggregateCoverageOptions {
  spec?: string;
  depthBound?: number;
  /** Target rows from the enumeration step, including unreachable ones. */
  targets?: readonly TargetOutcome[];
  /** Per-plan V8 coverage fingerprints, when collected. */
  fingerprints?: ReadonlyMap<string, string>;
}

/**
 * Pairs of plans sharing a coverage fingerprint. Sorted for stable reports.
 */
export function findCollapsedPlans(
  fingerprints: ReadonlyMap<string, string>,
): Array<[string, string]> {
  const byPrint = new Map<string, string[]>();
  for (const [plan, print] of fingerprints) {
    const bucket = byPrint.get(print);
    if (bucket) bucket.push(plan);
    else byPrint.set(print, [plan]);
  }
  const out: Array<[string, string]> = [];
  for (const bucket of byPrint.values()) {
    if (bucket.length < 2) continue;
    const sorted = [...bucket].sort();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        out.push([sorted[i]!, sorted[j]!]);
      }
    }
  }
  return out.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
}

export function aggregateCoverage(
  results: readonly PlanRunResult[],
  opts: AggregateCoverageOptions = {},
): ModelCoverage {
  const ran = results.filter((r) => r.skipped === undefined);
  const skipped = results.length - ran.length;
  const notExercised = ran
    .filter((r) => r.mismatches.some((m) => m.field === "injection"))
    .map((r) => r.plan.name);

  const targets = opts.targets ?? [];
  const unreachable = targets.filter((t) => t.status === "unreachable").length;
  // Without an explicit target list, the plans themselves are the targets:
  // one plan per reachable state is exactly how the enumerator emits them.
  const targeted = targets.length > 0 ? targets.length : results.length;
  const reached = targets.length > 0 ? targets.length - unreachable : ran.length;

  const coverage: ModelCoverage = {
    statesTargeted: targeted,
    statesReached: reached,
    statesUnreachableInBound: unreachable,
    plansRun: ran.length,
    plansSkipped: skipped,
    plansNotExercised: notExercised,
    mismatches: ran.flatMap((r) => r.mismatches),
    collapsedPlans: opts.fingerprints ? findCollapsedPlans(opts.fingerprints) : [],
  };
  if (opts.spec !== undefined) coverage.spec = opts.spec;
  if (opts.depthBound !== undefined) coverage.depthBound = opts.depthBound;
  return coverage;
}

/** One-screen summary for CLI output. */
export function formatModelCoverage(coverage: ModelCoverage): string {
  const lines: string[] = [];
  lines.push("=== MODEL COVERAGE ===");
  if (coverage.spec) lines.push(`Spec: ${coverage.spec}`);
  const bound = coverage.depthBound !== undefined ? ` (depth <= ${coverage.depthBound})` : "";
  lines.push(
    `States: ${coverage.statesReached}/${coverage.statesTargeted} reachable${bound}` +
      (coverage.statesUnreachableInBound > 0
        ? `, ${coverage.statesUnreachableInBound} unreachable`
        : ""),
  );
  lines.push(`Plans run: ${coverage.plansRun}${coverage.plansSkipped > 0 ? `, skipped: ${coverage.plansSkipped} (order-sensitive)` : ""}`);
  if (coverage.plansNotExercised.length > 0) {
    lines.push(`Not exercised (planned fault never fired): ${coverage.plansNotExercised.join(", ")}`);
  }
  if (coverage.collapsedPlans.length > 0) {
    lines.push("Collapsed plans (distinct model states, identical code coverage):");
    for (const [a, b] of coverage.collapsedPlans) lines.push(`  ${a} == ${b}`);
  }
  if (coverage.plansRun === 0) {
    lines.push("No plans ran — nothing was verified. Check that the plan directory is populated.");
  } else if (coverage.mismatches.length === 0) {
    lines.push("Mismatches: none — every plan matched the model's prediction");
  } else {
    lines.push(`Mismatches: ${coverage.mismatches.length}`);
    for (const m of coverage.mismatches) {
      lines.push(`  [${m.field}] ${m.plan}: ${m.detail}`);
    }
  }
  return lines.join("\n");
}

/**
 * True when nothing needs a human: no mismatches, nothing silently skipped,
 * and — the easy one to forget — at least one plan actually ran. A run of zero
 * plans has no mismatches by definition, and reporting that as a pass is how a
 * broken compile step looks like a green suite.
 */
export function modelRunPassed(coverage: ModelCoverage): boolean {
  return (
    coverage.plansRun > 0 &&
    coverage.mismatches.length === 0 &&
    coverage.plansSkipped === 0 &&
    coverage.plansNotExercised.length === 0
  );
}

/** Convenience for CLI / CI: plan names that produced at least one mismatch. */
export function failingPlans(coverage: ModelCoverage): string[] {
  return [...new Set(coverage.mismatches.map((m) => m.plan))].sort();
}

/** Re-exported for consumers that only import this module. */
export type { FaultPlan };
