/**
 * Delta-debugging (ddmin) over a recorded chaos trace, so the user can ask
 * "which of these 500 actions are actually needed to reproduce this bug?"
 *
 * The core `ddmin` helper is pure: it takes a sequence and an async predicate
 * and returns a 1-minimal subset. The rest of this module wires it up to the
 * trace format and to `chaos()` so the CLI subcommand can minimise against
 * a regex match on error-cluster fingerprints.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ChaosCrawler } from "./crawler.js";
import { readTrace, writeTrace, } from "./trace.js";
/**
 * Zeller's ddmin. Narrows `items` down to the minimal subsequence that still
 * satisfies `predicate` ("this reproduces the failure"). `predicate` should
 * return `true` when the subset still reproduces, `false` otherwise.
 *
 * The algorithm preserves order and is deterministic given a deterministic
 * predicate. Complexity is O(n log n) in the happy case and O(n²) worst case.
 */
export async function ddmin(items, predicate, onStep) {
    let current = [...items];
    let granularity = 2;
    let iteration = 0;
    while (current.length >= 2) {
        const chunkSize = Math.ceil(current.length / granularity);
        const chunks = [];
        for (let i = 0; i < current.length; i += chunkSize) {
            chunks.push(current.slice(i, i + chunkSize));
        }
        let reduced = false;
        // Phase 1 — try each chunk alone.
        for (const chunk of chunks) {
            iteration++;
            if (await predicate(chunk)) {
                onStep?.({ iteration, size: current.length, keptAfter: chunk.length });
                current = chunk;
                granularity = 2;
                reduced = true;
                break;
            }
        }
        if (reduced)
            continue;
        // Phase 2 — try each complement (drop one chunk at a time).
        for (let ci = 0; ci < chunks.length; ci++) {
            const chunk = chunks[ci];
            const chunkStart = ci * chunkSize;
            const complement = [
                ...current.slice(0, chunkStart),
                ...current.slice(chunkStart + chunk.length),
            ];
            if (complement.length === 0)
                continue;
            iteration++;
            if (await predicate(complement)) {
                onStep?.({ iteration, size: current.length, keptAfter: complement.length });
                current = complement;
                granularity = Math.max(granularity - 1, 2);
                reduced = true;
                break;
            }
        }
        if (reduced)
            continue;
        // Phase 3 — increase granularity. If we can't split finer, we're 1-minimal.
        if (granularity >= current.length)
            break;
        granularity = Math.min(current.length, granularity * 2);
    }
    return current;
}
/** True when any error cluster fingerprint matches the regex. */
export function reportMatches(report, pattern) {
    for (const c of report.errorClusters) {
        if (pattern.test(c.fingerprint))
            return true;
    }
    return false;
}
/**
 * Build a new trace from `source`, keeping every meta / visit entry and only
 * the action entries in `keepActions`. Visit→action grouping is preserved so
 * actions stay on the same pages they were originally recorded on.
 */
export function traceWithActions(source, keepActions) {
    const out = [];
    for (const entry of source) {
        if (entry.kind === "action") {
            if (keepActions.has(entry))
                out.push(entry);
        }
        else {
            out.push(entry);
        }
    }
    return out;
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
export async function minimizeTrace(options) {
    const source = options.trace;
    const originalActions = source.filter((e) => e.kind === "action");
    if (originalActions.length === 0) {
        return {
            originalActions,
            minimizedActions: [],
            minimizedTrace: [...source],
            iterations: 0,
        };
    }
    const workdir = mkdtempSync(join(options.tmpDir ?? tmpdir(), "chaos-min-"));
    let iterationCounter = 0;
    try {
        const predicate = async (subset) => {
            const keep = new Set(subset);
            const candidate = traceWithActions(source, keep);
            const tracePath = join(workdir, `iter-${iterationCounter++}.jsonl`);
            writeTrace(tracePath, candidate);
            const crawler = new ChaosCrawler({
                ...(options.crawlerOverrides ?? {}),
                baseUrl: options.baseUrl,
                traceReplay: tracePath,
            });
            const report = await crawler.start();
            return Boolean(await options.predicate(report));
        };
        const minimizedActions = await ddmin(originalActions, predicate, options.onStep);
        const keep = new Set(minimizedActions);
        const minimizedTrace = traceWithActions(source, keep);
        return {
            originalActions,
            minimizedActions,
            minimizedTrace,
            iterations: iterationCounter,
        };
    }
    finally {
        rmSync(workdir, { recursive: true, force: true });
    }
}
function parseMinimizeArgs(argv) {
    const { values } = parseArgs({
        args: argv,
        options: {
            url: { type: "string" },
            trace: { type: "string" },
            match: { type: "string" },
            "trace-out": { type: "string" },
            "max-pages": { type: "string" },
            timeout: { type: "string" },
            "ignore-analytics": { type: "boolean", default: false },
            quiet: { type: "boolean", default: false },
            help: { type: "boolean", default: false },
        },
        allowPositionals: true,
    });
    if (values.help) {
        printMinimizeHelp();
        process.exit(0);
    }
    if (!values.url)
        fail("--url is required");
    if (!values.trace)
        fail("--trace is required");
    if (!values.match)
        fail("--match is required");
    let match;
    try {
        match = new RegExp(values.match);
    }
    catch (err) {
        fail(`--match is not a valid regex: ${err.message}`);
    }
    return {
        baseUrl: values.url,
        tracePath: values.trace,
        match: match,
        traceOut: values["trace-out"] ?? "min.trace.jsonl",
        maxPages: values["max-pages"] ? Number(values["max-pages"]) : undefined,
        timeout: values.timeout ? Number(values.timeout) : undefined,
        ignoreAnalytics: values["ignore-analytics"] ?? false,
        quiet: values.quiet ?? false,
    };
}
function printMinimizeHelp() {
    console.log(`
chaosbringer minimize — shrink a recorded trace to the minimum actions
that still reproduce a failure.

USAGE:
  chaosbringer minimize --url <url> --trace <in.jsonl> --match <regex> [options]

OPTIONS:
  --url <url>           Base URL under test (required)
  --trace <path>        Source trace to shrink (required)
  --match <regex>       Reproduction predicate — matches error cluster fingerprints
  --trace-out <path>    Where to write the minimized trace (default: min.trace.jsonl)
  --max-pages <n>       Forward to the crawler
  --timeout <ms>        Forward to the crawler
  --ignore-analytics    Suppress common analytics noise during replays
  --quiet               Print only the final summary
  --help                Show this help
`);
}
function fail(msg) {
    console.error(`Error: ${msg}`);
    console.error("Run `chaosbringer minimize --help` for usage information.");
    process.exit(1);
}
/** Entry point wired from src/cli.ts when the `minimize` subcommand is used. */
export async function runMinimizeCli(argv) {
    const args = parseMinimizeArgs(argv);
    const trace = readTrace(args.tracePath);
    const meta = trace[0];
    if (!args.quiet) {
        const actionCount = trace.filter((e) => e.kind === "action").length;
        console.log(`Minimizing ${actionCount} actions from ${args.tracePath} (baseUrl=${meta.baseUrl}, match=${args.match})`);
    }
    const overrides = {};
    if (args.maxPages !== undefined)
        overrides.maxPages = args.maxPages;
    if (args.timeout !== undefined)
        overrides.timeout = args.timeout;
    if (args.ignoreAnalytics) {
        const { COMMON_IGNORE_PATTERNS } = await import("./crawler.js");
        overrides.ignoreErrorPatterns = COMMON_IGNORE_PATTERNS;
    }
    const result = await minimizeTrace({
        baseUrl: args.baseUrl,
        trace,
        predicate: (report) => reportMatches(report, args.match),
        crawlerOverrides: overrides,
        onStep: args.quiet
            ? undefined
            : (info) => console.log(`  iter=${info.iteration} size=${info.size} kept=${info.keptAfter}`),
    });
    writeTrace(args.traceOut, result.minimizedTrace);
    if (!args.quiet) {
        console.log("");
        console.log(`Reduced ${result.originalActions.length} → ${result.minimizedActions.length} actions over ${result.iterations} replays`);
        console.log(`Minimized trace written to ${args.traceOut}`);
    }
}
