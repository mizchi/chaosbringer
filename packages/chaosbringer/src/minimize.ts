/**
 * Delta-debugging (ddmin) over a recorded chaos trace, so the user can ask
 * "which of these 500 actions are actually needed to reproduce this bug?"
 *
 * The search itself is `ddmin` in `./ddmin.js` — pure, and kept there so
 * browser-free callers can reach it without importing `ChaosCrawler`. This
 * module wires it up to the trace format and to `chaos()` so the CLI
 * subcommand can minimise against a regex match on error-cluster
 * fingerprints, and re-exports `ddmin` under the path it has always had.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ChaosCrawler } from "./crawler.js";
import { ddmin } from "./ddmin.js";
import {
  groupTrace,
  readTrace,
  writeTrace,
  type TraceAction,
  type TraceEntry,
  type TraceMeta,
} from "./trace.js";
import type { CrawlReport } from "./types.js";

// `ddmin` moved to its own module so browser-free callers can use it without
// pulling Playwright in through `ChaosCrawler` above. Re-exported here because
// this is the path it has always been published under.
export { ddmin } from "./ddmin.js";

/** True when any error cluster fingerprint matches the regex. */
export function reportMatches(report: CrawlReport, pattern: RegExp): boolean {
  for (const c of report.errorClusters) {
    if (pattern.test(c.fingerprint)) return true;
  }
  return false;
}

/**
 * Build a new trace from `source`, keeping every meta / visit entry and only
 * the action entries in `keepActions`. Visit→action grouping is preserved so
 * actions stay on the same pages they were originally recorded on.
 */
export function traceWithActions(
  source: readonly TraceEntry[],
  keepActions: ReadonlySet<TraceAction>
): TraceEntry[] {
  const out: TraceEntry[] = [];
  for (const entry of source) {
    if (entry.kind === "action") {
      if (keepActions.has(entry)) out.push(entry);
    } else {
      out.push(entry);
    }
  }
  return out;
}

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
  onStep?: (info: { iteration: number; size: number; keptAfter: number }) => void;
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
export async function minimizeTrace(options: MinimizeOptions): Promise<MinimizeResult> {
  const source = options.trace;
  const originalActions: TraceAction[] = source.filter(
    (e): e is TraceAction => e.kind === "action"
  );

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
    const predicate = async (subset: TraceAction[]): Promise<boolean> => {
      const keep = new Set(subset);
      const candidate = traceWithActions(source, keep);
      const tracePath = join(workdir, `iter-${iterationCounter++}.jsonl`);
      writeTrace(tracePath, candidate);
      const crawler = new ChaosCrawler({
        ...(options.crawlerOverrides ?? {}),
        baseUrl: options.baseUrl,
        traceReplay: tracePath,
      } as never);
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
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

/** Parsed CLI arguments for the minimize subcommand. */
interface MinimizeCliArgs {
  baseUrl: string;
  tracePath: string;
  match: RegExp;
  traceOut: string;
  maxPages?: number;
  timeout?: number;
  ignoreAnalytics: boolean;
  quiet: boolean;
}

function parseMinimizeArgs(argv: string[]): MinimizeCliArgs {
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
  if (!values.url) fail("--url is required");
  if (!values.trace) fail("--trace is required");
  if (!values.match) fail("--match is required");

  let match: RegExp;
  try {
    match = new RegExp(values.match!);
  } catch (err) {
    fail(`--match is not a valid regex: ${(err as Error).message}`);
  }

  return {
    baseUrl: values.url!,
    tracePath: values.trace!,
    match: match!,
    traceOut: values["trace-out"] ?? "min.trace.jsonl",
    maxPages: values["max-pages"] ? Number(values["max-pages"]) : undefined,
    timeout: values.timeout ? Number(values.timeout) : undefined,
    ignoreAnalytics: values["ignore-analytics"] ?? false,
    quiet: values.quiet ?? false,
  };
}

function printMinimizeHelp(): void {
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

function fail(msg: string): never {
  console.error(`Error: ${msg}`);
  console.error("Run `chaosbringer minimize --help` for usage information.");
  process.exit(1);
}

/** Entry point wired from src/cli.ts when the `minimize` subcommand is used. */
export async function runMinimizeCli(argv: string[]): Promise<void> {
  const args = parseMinimizeArgs(argv);
  const trace = readTrace(args.tracePath);
  const meta = trace[0] as TraceMeta;

  if (!args.quiet) {
    const actionCount = trace.filter((e) => e.kind === "action").length;
    console.log(
      `Minimizing ${actionCount} actions from ${args.tracePath} (baseUrl=${meta.baseUrl}, match=${args.match})`
    );
  }

  const overrides: Record<string, unknown> = {};
  if (args.maxPages !== undefined) overrides.maxPages = args.maxPages;
  if (args.timeout !== undefined) overrides.timeout = args.timeout;
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
      : (info) =>
          console.log(
            `  iter=${info.iteration} size=${info.size} kept=${info.keptAfter}`
          ),
  });

  writeTrace(args.traceOut, result.minimizedTrace);
  if (!args.quiet) {
    console.log("");
    console.log(
      `Reduced ${result.originalActions.length} → ${result.minimizedActions.length} actions over ${result.iterations} replays`
    );
    console.log(`Minimized trace written to ${args.traceOut}`);
  }
}
