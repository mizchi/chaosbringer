/**
 * Compute a diff between a baseline report and the current report. The goal is
 * regression detection in CI: surface what's newly broken since the last run
 * while ignoring clusters / pages that were already broken.
 *
 * Clusters are matched by `ErrorCluster.key` (already fingerprinted, stable
 * across runs); pages are matched by URL. Nothing else is compared.
 */
import type { CrawlReport, ReportDiff } from "./types.js";
export declare function diffReports(baseline: CrawlReport, current: CrawlReport, options?: {
    baselinePath?: string;
}): ReportDiff;
/**
 * Read a baseline report from disk. Returns `null` when the file is missing —
 * callers (CLI / chaos()) treat that as "first run, no baseline yet" and warn.
 * Throws if the file exists but is not a parseable report.
 */
export declare function loadBaseline(path: string): CrawlReport | null;
/**
 * True when the diff contains regressions worth failing a run over. Used by
 * `--baseline-strict` — a less aggressive default than failing on any diff
 * (which would flag "resolved" pages too).
 */
export declare function hasRegressions(diff: ReportDiff): boolean;
//# sourceMappingURL=diff.d.ts.map