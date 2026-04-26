/**
 * Flake detection. Runs chaos N times with the same seed and reports which
 * error clusters are stable (fire in every run) vs flaky (fire in some but
 * not all). Useful for triaging whether a failure is real or a race.
 *
 * The analysis itself is a pure function over CrawlReports; orchestration
 * (running chaos N times + pretty-printing) is layered on top so tests can
 * exercise the analysis without a browser.
 */
import type { CrawlReport, PageError } from "./types.js";
export interface ClusterOccurrence {
    key: string;
    type: PageError["type"];
    fingerprint: string;
    /** Count per run (length === N). Zero means the cluster did not fire. */
    perRunCounts: number[];
    /** Number of runs in which this cluster fired at least once. */
    runsWithCluster: number;
}
export interface PageOccurrence {
    url: string;
    /** Runs in which this URL was visited AND had at least one error. */
    failedInRuns: number;
    /** Runs in which the URL was visited at all (regardless of outcome). */
    visitedInRuns: number;
}
export interface FlakeAnalysis {
    runs: number;
    /** Clusters that fired in every run. */
    stableClusters: ClusterOccurrence[];
    /** Clusters that fired in some runs but not others. */
    flakyClusters: ClusterOccurrence[];
    /** Pages whose failed/clean state differed across runs. */
    flakyPages: PageOccurrence[];
    /** Per-run duration in ms, in input order. */
    durations: number[];
}
/**
 * Given N CrawlReports from runs of the same configuration, separate the
 * error clusters into stable (always fire) vs flaky (inconsistent), and the
 * pages into flaky (different failed/clean outcomes) vs stable.
 */
export declare function flakeReport(reports: readonly CrawlReport[]): FlakeAnalysis;
export declare function formatFlakeReport(analysis: FlakeAnalysis): string;
/** Entry point wired from src/cli.ts when the `flake` subcommand is used. */
export declare function runFlakeCli(argv: string[]): Promise<void>;
//# sourceMappingURL=flake.d.ts.map