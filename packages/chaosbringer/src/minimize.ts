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
import {
  asUsageError,
  CRAWL_CLI_OPTIONS,
  type CrawlCliValues,
  crawlCliOptionsFor,
  crawlCliPeerNeeds,
  crawlerOptionsFromCli,
  formatFlagList,
  parseArgsSuggesting,
  parseNumberFlag,
  REPLAY_CRAWL_FLAGS,
  REPLAY_REFUSED_FLAGS,
} from "./cli-crawl-options.js";
import { parseInvariantsFlag } from "./cli-invariants.js";
import { UsageError } from "./cli-usage.js";
import { ChaosCrawler } from "./crawler.js";
import { ddmin } from "./ddmin.js";
import { checkInputFiles } from "./input-files.js";
import { assertPeers } from "./peers.js";
import { formatReproFlags } from "./repro-command.js";
import {
  metaOf,
  readTrace,
  TRACE_FORMAT_VERSION,
  traceSetupFlags,
  traceSetupOf,
  writeTrace,
  type TraceAction,
  type TraceEntry,
  type TraceMeta,
  type TraceSetup,
} from "./trace.js";
import type { CrawlerOptions, CrawlReport, ReproFlag } from "./types.js";
import { validateOptions } from "./validate.js";

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
  /**
   * Whether a replay of the whole trace matched the predicate. `false` means
   * there was no failure to shrink: nothing was minimized, and
   * `minimizedTrace` is the source trace.
   */
  reproduced: boolean;
}

/**
 * The search `minimizeTrace` runs, without the crawler. A replay of every
 * action has to reproduce first: ddmin assumes it, and without the check a
 * predicate that never matched kept every action through the whole search and
 * read as a successful minimization. Then no actions at all, which ddmin
 * never tries (a failure on the page loads alone needs none of them), then
 * ddmin.
 */
export async function minimizeActions<T>(
  items: readonly T[],
  reproduces: (subset: T[]) => Promise<boolean>,
  onStep?: (info: { iteration: number; size: number; keptAfter: number }) => void
): Promise<{ reproduced: boolean; minimized: T[] }> {
  if (!(await reproduces([...items]))) return { reproduced: false, minimized: [...items] };
  if (items.length === 0 || (await reproduces([]))) return { reproduced: true, minimized: [] };
  // ddmin counts its own calls; the two replays above come first, so its
  // progress lines number replays as the summary's total does.
  const offset = (info: { iteration: number; size: number; keptAfter: number }) =>
    onStep?.({ ...info, iteration: info.iteration + 2 });
  return { reproduced: true, minimized: await ddmin(items, reproduces, onStep && offset) };
}

/**
 * Drive ddmin over the action entries in a trace. For each candidate subset,
 * writes a temp trace, runs the crawler in replay mode, and evaluates the
 * predicate against the resulting report.
 *
 * Visit entries are preserved in full so URLs in the replay match the
 * original — only action removal is attempted. When a replay of the whole
 * trace does not match, the result says `reproduced: false` and keeps every
 * action (see `minimizeActions`).
 */
export async function minimizeTrace(options: MinimizeOptions): Promise<MinimizeResult> {
  const source = options.trace;
  const originalActions: TraceAction[] = source.filter(
    (e): e is TraceAction => e.kind === "action"
  );

  const workdir = mkdtempSync(join(options.tmpDir ?? tmpdir(), "chaos-min-"));
  let iterationCounter = 0;

  try {
    const predicate = async (subset: TraceAction[]): Promise<boolean> => {
      const keep = new Set(subset);
      const candidate = traceWithActions(source, keep);
      const tracePath = join(workdir, `iter-${iterationCounter++}.jsonl`);
      writeTrace(tracePath, candidate);
      const crawler = new ChaosCrawler({
        ...options.crawlerOverrides,
        baseUrl: options.baseUrl,
        traceReplay: tracePath,
      } as never);
      const report = await crawler.start();
      return Boolean(await options.predicate(report));
    };

    const { reproduced, minimized } = await minimizeActions(originalActions, predicate, options.onStep);
    return {
      originalActions,
      minimizedActions: minimized,
      minimizedTrace: reproduced ? traceWithActions(source, new Set(minimized)) : [...source],
      iterations: iterationCounter,
      reproduced,
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

/** minimize's own flags. */
const MINIMIZE_OPTIONS = {
  url: { type: "string" },
  trace: { type: "string" },
  match: { type: "string" },
  "trace-out": { type: "string" },
  "max-pages": { type: "string" },
  quiet: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;

const REFUSED_FLAGS = Object.keys(REPLAY_REFUSED_FLAGS) as Array<keyof typeof REPLAY_REFUSED_FLAGS>;

/** Parsed CLI arguments for the minimize subcommand. */
export interface MinimizeCliArgs {
  /** `--url`; without it, the trace's own `baseUrl`. */
  url?: string;
  tracePath: string;
  match: RegExp;
  traceOut: string;
  quiet: boolean;
  /** `--max-pages`, given: a replay visits every page of the trace, so it changes nothing (a note says so). */
  maxPagesGiven: boolean;
  /** The crawl flags given (`REPLAY_CRAWL_FLAGS`), as the main crawl parses them. */
  replay: Partial<CrawlCliValues>;
  /** Which of them were given, by name: each overrides what the trace recorded. */
  replayGiven: ReadonlySet<string>;
}

/**
 * Exported for tests. Every refusal throws a `UsageError` (or what
 * `parseArgs` throws for an unknown flag), which cli.ts reports with exit 2:
 * a crawl flag of `REPLAY_REFUSED_FLAGS` says why it cannot apply, and a
 * `--` is refused, since a pasted crawl command's `--seed` and
 * `--max-actions` are exactly what a trace replaces (the trace records the
 * rest of its setup).
 */
export function parseMinimizeArgs(argv: string[]): MinimizeCliArgs {
  if (argv.includes("--")) {
    throw new UsageError(
      "minimize takes no crawl command after --: the trace records the crawl's setup (format v2), " +
        "and a flag given here overrides it",
    );
  }
  const { values, positionals, tokens } = parseArgsSuggesting({
    args: argv,
    options: {
      ...crawlCliOptionsFor(REPLAY_CRAWL_FLAGS),
      // Parsed so that each is refused with why, not as an unknown flag.
      ...Object.fromEntries(REFUSED_FLAGS.map((f) => [f, CRAWL_CLI_OPTIONS[f]])),
      ...MINIMIZE_OPTIONS,
    },
    allowPositionals: true,
    tokens: true,
  });
  const given = new Set<string>(tokens.flatMap((t) => (t.kind === "option" ? [t.name] : [])));

  if (values.help) {
    printMinimizeHelp();
    process.exit(0);
  }
  const refused = REFUSED_FLAGS.find((f) => given.has(f));
  if (refused !== undefined) throw new UsageError(`--${refused} does not apply to minimize: ${REPLAY_REFUSED_FLAGS[refused]}`);
  // A stray word used to be dropped silently, as flake's were: a URL given
  // bare replayed against the trace's server instead of the one named.
  const stray = positionals[0];
  if (stray !== undefined) {
    fail(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(stray)
        ? `unexpected argument "${stray}": give the URL to replay against as --url ${stray}`
        : `unexpected argument "${stray}": minimize takes flags only (--trace <file> --match <regex>, and --url <url>)`,
    );
  }
  if (!values.trace) fail("--trace is required");
  if (!values.match) fail("--match is required");

  let match: RegExp;
  try {
    match = new RegExp(values.match!);
  } catch (err) {
    fail(`--match is not a valid regex: ${(err as Error).message}`);
  }
  // Checked as the main crawl checks it, though no replay reads it.
  if (values["max-pages"]) parseNumberFlag("--max-pages", values["max-pages"], { min: 1, integer: true });

  const replayFlags: readonly string[] = REPLAY_CRAWL_FLAGS;
  const replayGiven = new Set([...given].filter((f) => replayFlags.includes(f)));
  const replay = Object.fromEntries(Object.entries(values).filter(([k]) => replayFlags.includes(k))) as Partial<CrawlCliValues>;
  // The crawl's own checks of these flags' values, before the trace is read.
  asUsageError(() => crawlerOptionsFromCli(replay, "http://minimize.invalid/"));

  return {
    url: values.url,
    tracePath: values.trace!,
    match: match!,
    traceOut: values["trace-out"] ?? "min.trace.jsonl",
    quiet: values.quiet ?? false,
    maxPagesGiven: Boolean(values["max-pages"]),
    replay,
    replayGiven,
  };
}

/** One setting spelled by several flags: given any of them, the flag replaces all of what was recorded for it. */
const REPLAY_GROUP: Readonly<Record<string, string>> = {
  "ignore-analytics": "ignore-error",
  "ignore-preset": "ignore-error",
  "data-safety": "invariants",
  axe: "invariants",
  "axe-tags": "invariants",
  "no-headless": "headless",
};
const replayGroup = (flag: string) => REPLAY_GROUP[flag] ?? flag;

export interface ReplaySetup {
  /** Every replay's crawler options. */
  options: CrawlerOptions;
  /** What of the trace's setup was applied, as crawl flags. */
  applied: ReproFlag[];
  /** The recorded settings a flag given replaced, by the flag (`--settle`). */
  overridden: string[];
  /** The crawl flags' values the options were built from. */
  values: Partial<CrawlCliValues>;
}

/**
 * The options every replay runs with: the trace's recorded `setup`, then
 * the flags given, each replacing what was recorded for its setting (an
 * `--ignore-error` replaces the recorded ignore patterns, presets and
 * `--ignore-analytics` with it, and an `--invariants` the recorded
 * invariants and `--axe`). Throws a `UsageError` on what the main crawl
 * refuses.
 */
export function replaySetup(
  setup: TraceSetup | undefined,
  args: Pick<MinimizeCliArgs, "replay" | "replayGiven">,
  baseUrl: string,
): ReplaySetup {
  // An `--axe-tags` given alone retags the recorded axe check. As one of the
  // invariants flags it would replace the recorded `--axe` and `--invariants`
  // with itself, which builds nothing without `--axe`, and the replays would
  // run with no checks at all.
  const tagsOnly = args.replayGiven.has("axe-tags") && !["axe", "invariants", "data-safety"].some((f) => args.replayGiven.has(f));
  const groupOf = (flag: string) => (tagsOnly && flag === "axe-tags" ? flag : replayGroup(flag));
  const givenGroups = new Set([...args.replayGiven].map(groupOf));
  const recorded = traceSetupFlags(setup);
  const keep = (f: ReproFlag) => !givenGroups.has(groupOf(f.flag.slice(2)));
  const applied = recorded.filter(keep);
  const overridden = [...new Set(recorded.filter((f) => !keep(f)).map((f) => `--${groupOf(f.flag.slice(2))}`))];
  // Unquoted words, as a shell would hand them over: a value that starts
  // with `-` joined to its flag, which parseArgs otherwise refuses.
  const words = applied.flatMap(({ flag, value }) =>
    value === undefined ? [flag] : value.startsWith("-") ? [`${flag}=${value}`] : [flag, value],
  );
  const fromTrace = parseArgsSuggesting({ args: words, options: crawlCliOptionsFor(REPLAY_CRAWL_FLAGS) }).values;
  const fromFlags = Object.fromEntries(Object.entries(args.replay).filter(([k]) => args.replayGiven.has(k)));
  const values: Partial<CrawlCliValues> = { ...fromTrace, ...fromFlags };
  if (tagsOnly && !values.axe && !asUsageError(() => parseInvariantsFlag(values.invariants).axe)) {
    throw new UsageError(
      "--axe-tags without --axe: the trace recorded no axe check for it to tag; give --axe --axe-tags <list>",
    );
  }
  const options = asUsageError(() => {
    const built = crawlerOptionsFromCli(values, baseUrl);
    validateOptions(built);
    return built;
  });
  return { options, applied, overridden, values };
}

function printMinimizeHelp(): void {
  console.log(`
chaosbringer minimize — shrink a recorded trace to the minimum actions
that still reproduce a failure.

USAGE:
  chaosbringer minimize --trace <in.jsonl> --match <regex> [options]

OPTIONS:
  --trace <path>        Source trace to shrink (required; exit 2 if missing or not a trace)
  --match <regex>       Reproduction predicate — matches error cluster fingerprints
  --url <url>           Base URL under test (default: the trace's)
  --trace-out <path>    Where to write the minimized trace (default: min.trace.jsonl)
  --max-pages <n>       Accepted, and changes nothing: a replay visits every page of the trace
  --quiet               Print only the final summary
  --help                Show this help

CRAWL FLAGS (as chaosbringer --help describes them), applied to every replay:
${formatFlagList(REPLAY_CRAWL_FLAGS, "  ")}
  A trace written with --trace-out (format v2) records the ones its crawl was
  given (all but --headless / --no-headless), and every replay uses them: the
  cookies of its --storage-state, its --settle, its --exclude, … A flag given
  here replaces what was recorded for it (--axe-tags alone retags the recorded
  axe check). A recorded relative path is read from the current directory.
  A v1 trace records none, and replays with the defaults.

REFUSED (exit 2: the trace decides the pages and the actions, and --match,
not the exit rules, decides whether a replay reproduced):
${formatFlagList(REFUSED_FLAGS, "  ")}
  and a crawl command after --.
`);
}

/** A usage error: `chaosbringer minimize: <msg>` and exit 2, from cli.ts. */
function fail(msg: string): never {
  throw new UsageError(msg);
}

/** The setup's input files, and the flag each one is replaced by. */
const REPLAY_INPUT_FILES = [
  { key: "storageState", flag: "storage-state" },
  { key: "har", flag: "har-replay" },
] as const;

/**
 * `checkInputFiles` over the files the replays read. A path the trace
 * recorded (and no flag replaced) is refused as one: the user never gave
 * the flag the refusal names, and a relative path recorded where the crawl
 * ran is read from where minimize runs.
 */
export function checkReplayFiles(options: CrawlerOptions, given: ReadonlySet<string>): void {
  for (const { key, flag } of REPLAY_INPUT_FILES) {
    try {
      checkInputFiles(key === "storageState" ? { storageState: options.storageState } : { har: options.har });
    } catch (err) {
      if (!(err instanceof UsageError) || given.has(flag)) throw err;
      throw new UsageError(
        `${err.message} (recorded in the trace's setup, read from the current directory; give --${flag} <path> to replace it)`,
      );
    }
  }
}

/** Entry point wired from src/cli.ts when the `minimize` subcommand is used. */
export async function runMinimizeCli(argv: string[]): Promise<void> {
  const args = parseMinimizeArgs(argv);
  // A missing or malformed --trace is a usage error, like --trace-replay's.
  checkInputFiles({ traceReplay: args.tracePath }, { traceReplay: "--trace" });
  const trace = readTrace(args.tracePath);
  const meta = metaOf(trace);
  const baseUrl = args.url ?? meta.baseUrl;
  const setup = replaySetup(meta.setup, args, baseUrl);
  // The files the replays read, recorded or given, and the packages an
  // --invariants axe needs: before the first replay, as the crawl does.
  checkReplayFiles(setup.options, args.replayGiven);
  assertPeers(crawlCliPeerNeeds(setup.values));

  if (args.maxPagesGiven) {
    console.error("chaosbringer minimize: --max-pages changes nothing: a replay visits every page of the trace");
  }
  if (!args.quiet) {
    const actionCount = trace.filter((e) => e.kind === "action").length;
    console.log(
      `Minimizing ${actionCount} actions from ${args.tracePath} (baseUrl=${baseUrl}, match=${args.match})`
    );
    if (meta.v < 2) {
      console.log("  the trace (format v1) records no crawl setup: replaying with the defaults and the flags given");
    } else if (setup.applied.length > 0) {
      console.log(`  replaying with the trace's setup: ${formatReproFlags(setup.applied).join(" ")}`);
    }
    if (setup.overridden.length > 0) console.log(`  replaced by the flags given: ${setup.overridden.join(", ")}`);
  }

  const result = await minimizeTrace({
    baseUrl,
    trace,
    predicate: (report) => reportMatches(report, args.match),
    // `baseUrl` and `traceReplay` are minimizeTrace's own.
    crawlerOverrides: { ...setup.options },
    onStep: args.quiet
      ? undefined
      : (info) =>
          console.log(
            `  iter=${info.iteration} size=${info.size} kept=${info.keptAfter}`
          ),
  });

  if (!result.reproduced) {
    // Exit 1, not 2: the replay ran and found no failure, which is a result
    // about the run, not a refused invocation.
    console.error(
      `chaosbringer minimize: the failure did not reproduce: a replay of ${
        result.originalActions.length > 0
          ? `all ${result.originalActions.length} actions`
          : "the trace's page loads (it has no actions)"
      } matched no error cluster against ${args.match}, so there is nothing to minimize and ${args.traceOut} was not written. ` +
        "Check --match against the trace's report, and run `chaosbringer flake` first for a failure that only happens sometimes."
    );
    process.exitCode = 1;
    return;
  }

  // In the current format, recording the setup its replays reproduced under
  // (the trace's, with the flags given here), so a minimize of it loads its
  // pages the same way. A `chaosbringer --trace-replay` of it does not read
  // the setup: the crawler takes only the flags it is given.
  const [, ...entries] = result.minimizedTrace;
  const outSetup = traceSetupOf(setup.options);
  const outMeta: TraceMeta = { ...meta, v: TRACE_FORMAT_VERSION };
  if (outSetup) outMeta.setup = outSetup;
  else delete outMeta.setup;
  writeTrace(args.traceOut, [outMeta, ...entries]);
  if (!args.quiet) {
    console.log("");
    console.log(
      `Reduced ${result.originalActions.length} → ${result.minimizedActions.length} actions over ${result.iterations} replays`
    );
    console.log(`Minimized trace written to ${args.traceOut}`);
  }
}
