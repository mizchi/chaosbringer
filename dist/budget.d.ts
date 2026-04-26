/**
 * Per-page performance budget enforcement. Kept as pure helpers so unit tests
 * don't need a running browser — the crawler calls `checkPerformanceBudget`
 * after metrics are collected and appends the resulting PageErrors.
 */
import type { PageError, PerformanceBudget, PerformanceMetrics } from "./types.js";
/**
 * Compare measured metrics against a budget and return one invariant-violation
 * per breach. Returns an empty array when budget is undefined or empty,
 * or when every measured metric is within its limit.
 */
export declare function checkPerformanceBudget(metrics: PerformanceMetrics, budget: PerformanceBudget | undefined, url: string, now?: number): PageError[];
//# sourceMappingURL=budget.d.ts.map