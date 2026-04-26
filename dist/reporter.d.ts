/**
 * Report generation and formatting utilities
 */
import type { CrawlReport } from "./types.js";
export declare function formatReport(report: CrawlReport): string;
export declare function formatCompactReport(report: CrawlReport, strict?: boolean | ExitCodeOptions): string;
export declare function saveReport(report: CrawlReport, path: string): void;
export declare function printReport(report: CrawlReport, compact?: boolean, strict?: boolean | ExitCodeOptions): void;
export interface ExitCodeOptions {
    /** Treat console errors / JS exceptions as failures. */
    strict?: boolean;
    /** Fail when `report.diff` shows new clusters or newly failing pages. */
    baselineStrict?: boolean;
}
export declare function getExitCode(report: CrawlReport, strict?: boolean | ExitCodeOptions): number;
//# sourceMappingURL=reporter.d.ts.map