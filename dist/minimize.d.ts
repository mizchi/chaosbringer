/**
 * Delta-debugging (ddmin) over a recorded chaos trace, so the user can ask
 * "which of these 500 actions are actually needed to reproduce this bug?"
 *
 * The core `ddmin` helper is pure: it takes a sequence and an async predicate
 * and returns a 1-minimal subset. The rest of this module wires it up to the
 * trace format and to `chaos()` so the CLI subcommand can minimise against
 * a regex match on error-cluster fingerprints.
 */
import { type TraceAction, type TraceEntry } from "./trace.js";
import type { CrawlReport } from "./types.js";
/**
 * Zeller's ddmin. Narrows `items` down to the minimal subsequence that still
 * satisfies `predicate` ("this reproduces the failure"). `predicate` should
 * return `true` when the subset still reproduces, `false` otherwise.
 *
 * The algorithm preserves order and is deterministic given a deterministic
 * predicate. Complexity is O(n log n) in the happy case and O(n²) worst case.
 */
export declare function ddmin<T>(items: readonly T[], predicate: (subset: T[]) => Promise<boolean>, onStep?: (info: {
    iteration: number;
    size: number;
    keptAfter: number;
}) => void): Promise<T[]>;
/** True when any error cluster fingerprint matches the regex. */
export declare function reportMatches(report: CrawlReport, pattern: RegExp): boolean;
/**
 * Build a new trace from `source`, keeping every meta / visit entry and only
 * the action entries in `keepActions`. Visit→action grouping is preserved so
 * actions stay on the same pages they were originally recorded on.
 */
export declare function traceWithActions(source: readonly TraceEntry[], keepActions: ReadonlySet<TraceAction>): TraceEntry[];
export interface MinimizeOptions {
    /** Base URL under test. */
    baseUrl: string;
    /** Source trace to minimise. */
    trace: readonly TraceEntry[];
    /** Predicate — typically `reportMatches(report, /regex/)`. */
    predicate: (report: CrawlReport) => boolean | Promise<boolean>;
    /** Extra crawler knobs (timeout, maxPages, etc.) forwarded verbatim. */
    crawlerOverrides?: Record<string, unknown>;
    /** Observer for minimise progress. */
    onStep?: (info: {
        iteration: number;
        size: number;
        keptAfter: number;
    }) => void;
    /** Working directory for temp trace files. Default: os.tmpdir(). */
    tmpDir?: string;
}
export interface MinimizeResult {
    /** All actions from the source trace, in order. */
    originalActions: TraceAction[];
    /** Actions retained by ddmin. */
    minimizedActions: TraceAction[];
    /** Trace containing every visit + only the minimized actions. */
    minimizedTrace: TraceEntry[];
    /** Total replay runs executed. */
    iterations: number;
}
/**
 * Drive ddmin over the action entries in a trace. For each candidate subset,
 * writes a temp trace, runs the crawler in replay mode, and evaluates the
 * predicate against the resulting report.
 *
 * Visit entries are preserved in full so URLs in the replay match the
 * original — only action removal is attempted. A source trace with no actions
 * returns unchanged.
 */
export declare function minimizeTrace(options: MinimizeOptions): Promise<MinimizeResult>;
/** Entry point wired from src/cli.ts when the `minimize` subcommand is used. */
export declare function runMinimizeCli(argv: string[]): Promise<void>;
//# sourceMappingURL=minimize.d.ts.map