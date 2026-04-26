/**
 * Per-page performance budget enforcement. Kept as pure helpers so unit tests
 * don't need a running browser — the crawler calls `checkPerformanceBudget`
 * after metrics are collected and appends the resulting PageErrors.
 */
import { PERF_BUDGET_KEYS } from "./types.js";
/**
 * Compare measured metrics against a budget and return one invariant-violation
 * per breach. Returns an empty array when budget is undefined or empty,
 * or when every measured metric is within its limit.
 */
export function checkPerformanceBudget(metrics, budget, url, now = Date.now()) {
    if (!budget)
        return [];
    const errors = [];
    for (const key of PERF_BUDGET_KEYS) {
        const limit = budget[key];
        const measured = metrics[key];
        if (typeof limit !== "number" || typeof measured !== "number")
            continue;
        if (measured <= limit)
            continue;
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
