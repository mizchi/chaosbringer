/**
 * SLO evaluation against a `LoadReport`. Keep the surface small and
 * declarative — the value is in being a one-liner in CI:
 *
 *   const slo = { steps: { "shop/checkout": { p95Ms: 200, errorRate: 0.05 } } };
 *   assertSlo(report, slo);
 *
 * Design choices:
 * - Separate maps per scope (steps / scenarios / endpoints / totals)
 *   instead of a single namespaced map, so each value type is checked
 *   at compile time and missing-target typos surface as violations
 *   rather than silent skips.
 * - Comparisons are inclusive: `p95Ms: 200` means actual <= 200 passes.
 *   `errorRate: 0.05` means actual <= 0.05 passes.
 *   `minThroughputPerSec: 5` means actual >= 5 passes.
 * - Missing scope target (e.g. step "shop/buy" not in report) is itself
 *   a violation. The whole point of an SLO file is to express
 *   expectations — a silently-missing target defeats that.
 */
import type {
  EndpointReport,
  LoadReport,
  ScenarioReport,
  StepReport,
} from "./types.js";

export interface StepSloThresholds {
  /** Max acceptable p50 in ms. */
  p50Ms?: number;
  /** Max acceptable p95 in ms. */
  p95Ms?: number;
  /** Max acceptable p99 in ms. */
  p99Ms?: number;
  /** Max acceptable mean in ms. */
  meanMs?: number;
  /** Max acceptable error rate (failures / invocations). 0–1. */
  errorRate?: number;
}

export interface ScenarioSloThresholds {
  /** Max acceptable iteration error rate (iterationFailures / iterations). */
  errorRate?: number;
  /** Min acceptable throughput in iterations per second. */
  minThroughputPerSec?: number;
}

export interface EndpointSloThresholds {
  p50Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
  meanMs?: number;
  /** Max acceptable error rate (errorCount / count). */
  errorRate?: number;
}

export interface TotalsSloThresholds {
  /** Max acceptable iteration failures (count). */
  maxIterationFailures?: number;
  /** Max acceptable network errors (count). */
  maxNetworkErrors?: number;
  /** Max acceptable step failures (count). */
  maxStepFailures?: number;
}

export interface SloDefinition {
  /** Key format: `"scenarioName/stepName"`. */
  steps?: Record<string, StepSloThresholds>;
  /** Key format: scenario name. */
  scenarios?: Record<string, ScenarioSloThresholds>;
  /** Key format: endpoint key (e.g. `"/api/checkout"` after normalisation). */
  endpoints?: Record<string, EndpointSloThresholds>;
  totals?: TotalsSloThresholds;
}

export type SloScope = "step" | "scenario" | "endpoint" | "totals";

export interface SloViolation {
  scope: SloScope;
  /** Target key inside the scope (e.g. `"shop/checkout"`, `"shop"`, `"/api"`). */
  target: string;
  /** Threshold name (`p95Ms`, `errorRate`, etc.). */
  metric: string;
  /** The threshold from the SLO definition. */
  threshold: number;
  /**
   * The actual value from the report. `null` means the target was
   * missing entirely (and so the metric couldn't be evaluated).
   */
  actual: number | null;
  /** Human-readable single-line message. */
  message: string;
}

export interface SloResult {
  ok: boolean;
  violations: SloViolation[];
}

export function evaluateSlo(report: LoadReport, slo: SloDefinition): SloResult {
  const violations: SloViolation[] = [];

  // ---- steps ----
  if (slo.steps) {
    const stepIndex = indexSteps(report);
    for (const [target, thresholds] of Object.entries(slo.steps)) {
      const step = stepIndex.get(target);
      if (!step) {
        violations.push(missingTarget("step", target));
        continue;
      }
      compareMax(violations, "step", target, "p50Ms", thresholds.p50Ms, step.latency.p50Ms);
      compareMax(violations, "step", target, "p95Ms", thresholds.p95Ms, step.latency.p95Ms);
      compareMax(violations, "step", target, "p99Ms", thresholds.p99Ms, step.latency.p99Ms);
      compareMax(violations, "step", target, "meanMs", thresholds.meanMs, step.latency.meanMs);
      compareMax(violations, "step", target, "errorRate", thresholds.errorRate, step.errorRate);
    }
  }

  // ---- scenarios ----
  if (slo.scenarios) {
    const byName = new Map<string, ScenarioReport>(
      report.scenarios.map((s) => [s.name, s]),
    );
    for (const [target, thresholds] of Object.entries(slo.scenarios)) {
      const sc = byName.get(target);
      if (!sc) {
        violations.push(missingTarget("scenario", target));
        continue;
      }
      const errorRate = sc.iterations > 0 ? sc.iterationFailures / sc.iterations : 0;
      compareMax(violations, "scenario", target, "errorRate", thresholds.errorRate, errorRate);
      compareMin(
        violations,
        "scenario",
        target,
        "minThroughputPerSec",
        thresholds.minThroughputPerSec,
        sc.throughputPerSec,
      );
    }
  }

  // ---- endpoints ----
  if (slo.endpoints) {
    const byKey = new Map<string, EndpointReport>(
      report.endpoints.map((e) => [e.key, e]),
    );
    for (const [target, thresholds] of Object.entries(slo.endpoints)) {
      const ep = byKey.get(target);
      if (!ep) {
        violations.push(missingTarget("endpoint", target));
        continue;
      }
      compareMax(violations, "endpoint", target, "p50Ms", thresholds.p50Ms, ep.latency.p50Ms);
      compareMax(violations, "endpoint", target, "p95Ms", thresholds.p95Ms, ep.latency.p95Ms);
      compareMax(violations, "endpoint", target, "p99Ms", thresholds.p99Ms, ep.latency.p99Ms);
      compareMax(violations, "endpoint", target, "meanMs", thresholds.meanMs, ep.latency.meanMs);
      const errorRate = ep.count > 0 ? ep.errorCount / ep.count : 0;
      compareMax(violations, "endpoint", target, "errorRate", thresholds.errorRate, errorRate);
    }
  }

  // ---- totals ----
  if (slo.totals) {
    const t = slo.totals;
    compareMax(violations, "totals", "totals", "maxIterationFailures", t.maxIterationFailures, report.totals.iterationFailures);
    compareMax(violations, "totals", "totals", "maxNetworkErrors", t.maxNetworkErrors, report.totals.networkErrors);
    compareMax(violations, "totals", "totals", "maxStepFailures", t.maxStepFailures, report.totals.stepFailures);
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Like `evaluateSlo` but throws an Error listing every violation when
 * any threshold is breached. The thrown error's `.violations` field
 * carries the structured list for programmatic handling.
 */
export function assertSlo(report: LoadReport, slo: SloDefinition): void {
  const result = evaluateSlo(report, slo);
  if (result.ok) return;
  const err = new Error(formatSloViolations(result.violations)) as Error & {
    violations: SloViolation[];
  };
  err.violations = result.violations;
  throw err;
}

export function formatSloViolations(violations: ReadonlyArray<SloViolation>): string {
  if (violations.length === 0) return "SLO ok (0 violations)";
  const lines = [`SLO failed: ${violations.length} violation(s)`];
  for (const v of violations) lines.push(`  - ${v.message}`);
  return lines.join("\n");
}

// ---- helpers ----

function indexSteps(report: LoadReport): Map<string, StepReport> {
  const out = new Map<string, StepReport>();
  for (const sc of report.scenarios) {
    for (const st of sc.steps) {
      out.set(`${sc.name}/${st.name}`, st);
    }
  }
  return out;
}

function missingTarget(scope: SloScope, target: string): SloViolation {
  return {
    scope,
    target,
    metric: "<missing>",
    threshold: NaN,
    actual: null,
    message: `[${scope}] "${target}" not found in report (no samples)`,
  };
}

function compareMax(
  out: SloViolation[],
  scope: SloScope,
  target: string,
  metric: string,
  threshold: number | undefined,
  actual: number,
): void {
  if (threshold === undefined) return;
  if (actual <= threshold) return;
  out.push({
    scope,
    target,
    metric,
    threshold,
    actual,
    message: `[${scope}] ${target} ${metric}=${format(actual)} exceeds ${format(threshold)}`,
  });
}

function compareMin(
  out: SloViolation[],
  scope: SloScope,
  target: string,
  metric: string,
  threshold: number | undefined,
  actual: number,
): void {
  if (threshold === undefined) return;
  if (actual >= threshold) return;
  out.push({
    scope,
    target,
    metric,
    threshold,
    actual,
    message: `[${scope}] ${target} ${metric}=${format(actual)} below ${format(threshold)}`,
  });
}

function format(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3);
}
