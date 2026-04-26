/**
 * Action heatmap -- aggregate `report.actions[]` by target + type and surface
 * the most-frequent / least-reliable targets. Useful when triaging a noisy
 * crawl: which links / buttons does the chaos driver hit most, and which
 * ones disproportionately fail?
 *
 * Pure aggregation over the existing `actions` array -- no extra crawler
 * instrumentation. Run on any historical CrawlReport.
 */
import type { ActionResult } from "./types.js";
export interface ActionHeatmapEntry {
    /** Display key -- `target` if available, otherwise `selector`. */
    key: string;
    /** Action kind ("click" / "scroll" / "input" / "hover" / "navigate"). */
    type: ActionResult["type"];
    /** Total occurrences of this (type, key) pair. */
    count: number;
    /** Times the action returned `success: true`. */
    successCount: number;
    /** count - successCount. */
    failureCount: number;
    /** Times the click was blocked because the target was external. */
    blockedExternalCount: number;
    /** Times the click was skipped because another shard owns the target URL. */
    shardSkippedCount: number;
}
/**
 * Aggregate actions into a per-(type, key) heatmap, sorted by count
 * descending so the most-hit targets surface first. Stable: actions with
 * neither `target` nor `selector` collapse into a single `(unknown)` row.
 */
export declare function buildActionHeatmap(actions: readonly ActionResult[]): ActionHeatmapEntry[];
/**
 * Format the heatmap as a fixed-width table for the report. Truncates the
 * key column and limits to `top` rows so noisy reports don't drown the
 * console output.
 */
export declare function formatHeatmap(entries: readonly ActionHeatmapEntry[], top?: number): string;
//# sourceMappingURL=heatmap.d.ts.map