/**
 * Per-page performance budget enforcement. Kept as pure helpers so unit tests
 * don't need a running browser — the crawler calls `checkPerformanceBudget`
 * after metrics are collected and appends the resulting PageErrors.
 */

import { BUDGET_METRIC, type BudgetMetric } from "lightbringer/core";
import { perfRuleMatcher } from "./perf-key.js";
import type {
  PageError,
  PerfBudgetRule,
  PerformanceBudget,
  PerformanceMetrics,
  PerfSpanReport,
} from "./types.js";
import { PERF_BUDGET_KEYS } from "./types.js";

/**
 * Compare measured metrics against a budget and return one invariant-violation
 * per breach. Returns an empty array when budget is undefined or empty,
 * or when every measured metric is within its limit.
 */
export function checkPerformanceBudget(
  metrics: PerformanceMetrics,
  budget: PerformanceBudget | undefined,
  url: string,
  now: number = Date.now()
): PageError[] {
  if (!budget) return [];
  const errors: PageError[] = [];
  for (const key of PERF_BUDGET_KEYS) {
    const limit = budget[key];
    const measured = metrics[key];
    if (typeof limit !== "number" || typeof measured !== "number") continue;
    if (measured <= limit) continue;
    const name = `perf-budget.${key}`;
    errors.push({
      type: "invariant-violation",
      message: `[${name}] ${key}=${Math.round(measured)}ms > budget ${limit}ms`,
      invariantName: name,
      url,
      timestamp: now,
    });
  }
  return errors;
}

/**
 * Check spans against `perfBudgets` rules: one invariant-violation per span,
 * rule and metric over its limit. Every matching rule applies (not only the
 * first), so a broad rule and a tighter one for a hot route both hold; each
 * violation names its rule so two breaches of one metric read apart. A
 * metric the span did not measure is skipped, not failed — read through
 * lightbringer's own `BUDGET_METRIC`, so the value checked is the one
 * lightbringer's gates read.
 */
export function checkPerfBudgets(
  spans: readonly PerfSpanReport[],
  rules: readonly PerfBudgetRule[] | undefined,
  url: string,
  now: number = Date.now(),
): PageError[] {
  if (!rules || rules.length === 0 || spans.length === 0) return [];
  const compiled = rules.map((rule) => ({ rule, matches: perfRuleMatcher(rule) }));
  const errors: PageError[] = [];
  for (const span of spans) {
    for (const { rule, matches } of compiled) {
      if (!matches(span.key)) continue;
      for (const [metric, limit] of Object.entries(rule.budget) as [BudgetMetric, number | undefined][]) {
        if (typeof limit !== "number") continue;
        const get = BUDGET_METRIC[metric];
        const measured = get?.(span);
        if (typeof measured !== "number" || measured <= limit) continue;
        const name = `perf-budget.${metric}`;
        // Whole numbers from 10 up, one decimal below, for reading. Clustering
        // does not depend on this: fingerprintError folds the measured value
        // of every perf-budget message, so 23 vs 24 is one cluster. Rounding
        // must never print a value at or under the limit ("10 > budget 10"
        // for 10.4), so it falls back to the exact value when it would.
        let shown = measured >= 10 ? Math.round(measured) : Math.round(measured * 10) / 10;
        if (shown <= limit) shown = measured;
        errors.push({
          type: "invariant-violation",
          message: `[${name}] ${span.key}: ${metric}=${shown} > budget ${limit} (rule "${rule.match}")`,
          invariantName: name,
          url,
          timestamp: now,
        });
      }
    }
  }
  return errors;
}

/**
 * What `chaosbringer perf emit-budgets` writes: per-perfKey limits, each
 * `ceil(median × headroom)` over the runs it read.
 */
export interface PerfBudgetsFile {
  version: 1;
  headroom: number;
  budgets: Record<string, Partial<Record<BudgetMetric, number>>>;
}

/**
 * Read a `--perf-budgets` file's JSON as rules. Two shapes are accepted: the
 * `perfBudgets` array itself, or an `emit-budgets` file, whose keys become
 * `exact` rules: a key is a literal perfKey, and one whose selector holds a
 * `*` (`[class*="btn"]`) must not, as a glob, match — and budget — other
 * keys. Only the shape is checked here; callers validate the rules
 * (`validatePerfBudgets`), as the crawler and `perf gate` do.
 */
export function perfBudgetRulesFromJson(value: unknown, source = "perf budgets"): PerfBudgetRule[] {
  if (Array.isArray(value)) return value as PerfBudgetRule[];
  if (value !== null && typeof value === "object") {
    const file = value as Partial<PerfBudgetsFile>;
    if (file.budgets !== null && typeof file.budgets === "object" && !Array.isArray(file.budgets)) {
      if (file.version !== undefined && file.version !== 1) {
        throw new Error(`${source}: unsupported budgets file version ${JSON.stringify(file.version)} (expected 1)`);
      }
      return Object.entries(file.budgets).map(([match, budget]) => ({
        match,
        budget: budget as PerfBudgetRule["budget"],
        exact: true,
      }));
    }
  }
  throw new Error(
    `${source}: expected a perfBudgets array ([{ "match": …, "budget": {…} }]) or an emit-budgets file ({ "version": 1, "budgets": {…} })`,
  );
}
