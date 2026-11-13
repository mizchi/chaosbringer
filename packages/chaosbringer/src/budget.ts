/**
 * Per-page performance budget enforcement. Kept as pure helpers so unit tests
 * don't need a running browser — the crawler calls `checkPerformanceBudget`
 * after metrics are collected and appends the resulting PageErrors.
 */

import { BUDGET_METRIC, type BudgetMetric, type PaintWaitResult } from "lightbringer/core";
import type { LoadMetricsRead } from "./page-metrics.js";
import { perfRuleMatcher } from "./perf-key.js";
import type {
  BudgetUnmeasured,
  BudgetUnmeasuredReason,
  PageError,
  PerfBudgetKey,
  PerfBudgetRule,
  PerfSettleRecord,
  PerformanceBudget,
  PerformanceMetrics,
  PerfSpanReport,
} from "./types.js";
import { PERF_BUDGET_KEYS } from "./types.js";

/** One perf-budget breach as an invariant violation named `perf-budget.<metric>`. */
function perfBudgetError(metric: string, detail: string, url: string, now: number): PageError {
  return {
    type: "invariant-violation",
    message: `[perf-budget.${metric}] ${detail}`,
    invariantName: `perf-budget.${metric}`,
    url,
    timestamp: now,
  };
}

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
    errors.push(perfBudgetError(key, `${key}=${Math.round(measured)}ms > budget ${limit}ms`, url, now));
  }
  return errors;
}

/** What `unmeasuredBudget` knows about the load. */
export interface UnmeasuredContext {
  /** The load settle capped (no paint was awaited). */
  capped: boolean;
  /** The first metrics read, or null when there was none. */
  read: LoadMetricsRead | null;
  /** The paint wait after the load span, or null when none ran. */
  paint: PaintWaitResult | null;
}

/**
 * The budgeted metrics this load did not measure, each with why, where
 * `checkPerformanceBudget` skips them in silence. A note, never a violation:
 * an absent metric is not a breach (a blank shell has no FCP, a caller-owned
 * page no collector), but a budget that held because its metric was missing
 * must not read as one that held because the page was fast. A measured LCP is
 * noted only as `under-read`: frames stopped with a larger image loaded and
 * unpresented. Not when frames ran and nothing came (`frames`): the estimate
 * was then what was wrong, not the value.
 */
export function unmeasuredBudget(
  metrics: PerformanceMetrics,
  budget: PerformanceBudget | undefined,
  ctx: UnmeasuredContext,
): BudgetUnmeasured[] {
  if (!budget) return [];
  const out: BudgetUnmeasured[] = [];
  const { paint } = ctx;
  for (const key of PERF_BUDGET_KEYS) {
    if (typeof budget[key] !== "number") continue;
    const measured = metrics[key];
    if (typeof measured === "number") {
      if (key === "lcp" && paint?.outcome === "timeout" && paint.final.includes("lcp-image")) {
        out.push({
          metric: key,
          reason: "under-read",
          message: `a larger image (${paint.lcpImage?.url ?? "unknown"}) loaded but was not presented within ${Math.round(paint.waitedMs)} ms; lcp=${Math.round(measured)} is an earlier candidate`,
        });
      }
      continue;
    }
    const [reason, message] = unmeasuredReason(key, ctx);
    out.push({ metric: key, reason, message });
  }
  return out;
}

function unmeasuredReason(
  key: PerfBudgetKey,
  { capped, read, paint }: UnmeasuredContext,
): [BudgetUnmeasuredReason, string] {
  const hint = read?.paint;
  if (!hint) return ["not-reported", "the page's metrics could not be read"];
  if (key !== "fcp" && key !== "lcp" && key !== "tbt") return ["not-reported", "the browser did not report it"];
  if (key !== "fcp" && !hint.collector)
    return ["no-collector", "no lightbringer collector on this page (a caller-owned page, or setContent)"];
  if (capped) return ["capped", "the load settle capped, so the paint was not awaited"];
  if (!hint.visible || paint?.outcome === "hidden") return ["hidden", "the document was hidden, so it reports no paint"];
  // The check never answered (the page hung), or the page navigated or
  // closed during it: nothing says whether the paint came. Before the pending
  // branch, which an error's `final` (what was pending at the start) would
  // otherwise take for frames that ran.
  if (paint?.outcome === "error") return ["not-reported", "the page navigated or closed during the paint check"];
  if (paint?.outcome === "timeout" && paint.initial.length === 0)
    return ["not-reported", "the page did not answer the paint check"];
  if (paint?.final.includes("fcp")) {
    return paint.outcome === "timeout"
      ? ["stalled", `content was visible but no first contentful paint was reported within ${Math.round(paint.waitedMs)} ms: frames stopped`]
      : ["not-presented", `content was visible but no first contentful paint was reported within ${paint.frames ?? 0} frames`];
  }
  return key === "fcp"
    ? ["no-content", "the page showed no contentful content"]
    : ["no-content", "the browser reported no largest contentful paint candidate"];
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
        // Whole numbers from 10 up, one decimal below, for reading. Clustering
        // does not depend on this: fingerprintError folds the measured value
        // of every perf-budget message, so 23 vs 24 is one cluster. Rounding
        // must never print a value at or under the limit ("10 > budget 10"
        // for 10.4), so it falls back to the exact value when it would.
        let shown = measured >= 10 ? Math.round(measured) : Math.round(measured * 10) / 10;
        if (shown <= limit) shown = measured;
        errors.push(
          perfBudgetError(metric, `${span.key}: ${metric}=${shown} > budget ${limit} (rule "${rule.match}")`, url, now),
        );
      }
    }
  }
  return errors;
}

/**
 * What `chaosbringer perf emit-budgets` writes: per-perfKey limits, each
 * `max(ceil(median × headroom), ceil(median + floors[metric]))` over the runs
 * it read.
 */
export interface PerfBudgetsFile {
  version: 1;
  headroom: number;
  budgets: Record<string, Partial<Record<BudgetMetric, number>>>;
  /**
   * The settle mode of the crawls the budgets were measured from, when they
   * all recorded the same one. `perf gate` refuses reports settled
   * differently: the settle mode changes what an action span covers. Absent
   * in files written before it was recorded.
   */
  settle?: PerfSettleRecord;
  /**
   * `PERF_KEY_VERSION` of the keys in `budgets`. Keys of another version can
   * name different steps, so `perf gate` refuses reports of another version.
   * Absent in files written before it was recorded, which are version 1.
   */
  keyVersion?: number;
  /**
   * The absolute floor of each metric's budget: every budget is
   * `max(ceil(median × headroom), ceil(median + floor))` (lightbringer's
   * `DEFAULT_BUDGET_FLOORS`, with `--floor` overrides). A record of how the
   * file was emitted; nothing reads it back. Absent in files written before
   * floors existed, whose budgets are `ceil(median × headroom)`.
   */
  floors?: Partial<Record<BudgetMetric, number>>;
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
