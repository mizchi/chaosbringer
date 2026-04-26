/**
 * Trace file format. A trace is a JSONL log of everything the crawler did on
 * a run — enough to reconstruct the same sequence of navigations + actions
 * without re-rolling the RNG. Used as input to replay mode and to the
 * `minimize` subcommand.
 *
 * Line 1 is always a `meta` entry; every subsequent line is either a `visit`
 * (the crawler loaded that URL) or an `action` (what it did on the page).
 * Actions are grouped implicitly by the most recent preceding `visit`.
 */
import type { ActionResult } from "./types.js";
/** Incremented when the on-disk layout changes in a way replay cares about. */
export declare const TRACE_FORMAT_VERSION = 1;
export interface TraceMeta {
    kind: "meta";
    v: number;
    seed: number;
    baseUrl: string;
    /** Epoch ms of the run. Informational only — replay does not use it. */
    startTime: number;
}
export interface TraceVisit {
    kind: "visit";
    url: string;
}
/**
 * A performed action. Mirrors ActionResult but always carries the URL it
 * ran on, which is what replay needs to correlate actions with pages.
 */
export interface TraceAction {
    kind: "action";
    url: string;
    type: ActionResult["type"];
    target?: string;
    selector?: string;
    success: boolean;
    error?: string;
    blockedExternal?: boolean;
}
export type TraceEntry = TraceMeta | TraceVisit | TraceAction;
/**
 * Convert a recorded ActionResult + its URL into a TraceAction. Kept pure so
 * the crawler can serialize without importing node:fs in the hot path.
 */
export declare function actionToTraceEntry(action: ActionResult, url: string): TraceAction;
/** Render a trace as JSONL. Meta must be present and must come first. */
export declare function serializeTrace(entries: readonly TraceEntry[]): string;
/**
 * Parse JSONL back into entries. Blank lines are ignored; any other malformed
 * line throws — silently skipping would make minimize decisions uninterpretable.
 */
export declare function parseTrace(raw: string): TraceEntry[];
export declare function writeTrace(path: string, entries: readonly TraceEntry[]): void;
export declare function readTrace(path: string): TraceEntry[];
/**
 * Group a trace into (visit, actions[]) pairs in encounter order. Useful for
 * replay: each group is one page visit plus the actions performed on it.
 * Actions that appear before any visit (malformed trace) are discarded — the
 * parser already rejects those cases, but double-check here for safety.
 */
export interface TraceGroup {
    url: string;
    actions: TraceAction[];
}
export declare function groupTrace(entries: readonly TraceEntry[]): TraceGroup[];
export declare function metaOf(entries: readonly TraceEntry[]): TraceMeta;
//# sourceMappingURL=trace.d.ts.map