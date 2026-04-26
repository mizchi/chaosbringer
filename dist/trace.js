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
import { readFileSync, writeFileSync } from "node:fs";
/** Incremented when the on-disk layout changes in a way replay cares about. */
export const TRACE_FORMAT_VERSION = 1;
/**
 * Convert a recorded ActionResult + its URL into a TraceAction. Kept pure so
 * the crawler can serialize without importing node:fs in the hot path.
 */
export function actionToTraceEntry(action, url) {
    const out = {
        kind: "action",
        url,
        type: action.type,
        success: action.success,
    };
    if (action.target !== undefined)
        out.target = action.target;
    if (action.selector !== undefined)
        out.selector = action.selector;
    if (action.error !== undefined)
        out.error = action.error;
    if (action.blockedExternal !== undefined)
        out.blockedExternal = action.blockedExternal;
    return out;
}
/** Render a trace as JSONL. Meta must be present and must come first. */
export function serializeTrace(entries) {
    if (entries.length === 0 || entries[0].kind !== "meta") {
        throw new Error("serializeTrace: first entry must be kind=meta");
    }
    return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}
/**
 * Parse JSONL back into entries. Blank lines are ignored; any other malformed
 * line throws — silently skipping would make minimize decisions uninterpretable.
 */
export function parseTrace(raw) {
    const out = [];
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim().length === 0)
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch (err) {
            throw new Error(`parseTrace: line ${i + 1} is not valid JSON: ${err.message}`);
        }
        if (!parsed || typeof parsed !== "object" || !("kind" in parsed)) {
            throw new Error(`parseTrace: line ${i + 1} is missing "kind"`);
        }
        const kind = parsed.kind;
        if (kind !== "meta" && kind !== "visit" && kind !== "action") {
            throw new Error(`parseTrace: line ${i + 1} has unknown kind ${JSON.stringify(kind)}`);
        }
        out.push(parsed);
    }
    if (out.length === 0 || out[0].kind !== "meta") {
        throw new Error("parseTrace: trace is missing a leading meta entry");
    }
    const meta = out[0];
    if (meta.v !== TRACE_FORMAT_VERSION) {
        throw new Error(`parseTrace: unsupported trace format v=${meta.v} (this build understands v=${TRACE_FORMAT_VERSION})`);
    }
    return out;
}
export function writeTrace(path, entries) {
    writeFileSync(path, serializeTrace(entries));
}
export function readTrace(path) {
    return parseTrace(readFileSync(path, "utf-8"));
}
export function groupTrace(entries) {
    const groups = [];
    let current = null;
    for (const entry of entries) {
        if (entry.kind === "meta")
            continue;
        if (entry.kind === "visit") {
            current = { url: entry.url, actions: [] };
            groups.push(current);
        }
        else if (entry.kind === "action" && current) {
            current.actions.push(entry);
        }
    }
    return groups;
}
export function metaOf(entries) {
    const first = entries[0];
    if (!first || first.kind !== "meta")
        throw new Error("trace is missing a meta entry");
    return first;
}
