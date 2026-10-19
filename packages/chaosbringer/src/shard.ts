/**
 * Parallel sharding for the crawler.
 *
 * Shards partition the URL space by a stable hash. Running N crawlers with
 * `{ shardIndex: i, shardCount: N }` (i in [0, N)) lets them split work
 * disjointly; each shard only processes URLs whose hash maps to its index.
 * `baseUrl` is exempted so every shard can seed its BFS.
 *
 * The pure helpers (`fnv1a`, `shardOwns`, `mergeReports`) are unit-testable
 * without a browser; `runShardCli` is the CLI coordinator that spawns N child
 * processes and merges their reports.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUsageError, UsageError } from "./cli-usage.js";
import { errorMessage } from "./errors.js";
import { buildCrawlPerfSummary } from "./perf-summary.js";
import { clusterErrors } from "./clusters.js";
import { summarizePages } from "./filters.js";
import { randomSeed } from "./random.js";
import { formatQuietReport, printReport, getExitCode } from "./reporter.js";
import type {
  ActionResult,
  CrawlReport,
  DiscoveryMetrics,
  FaultInjectionStats,
  PageResult,
  PerfSettleRecord,
} from "./types.js";

/**
 * FNV-1a 32-bit hash. Fast, stable, non-cryptographic. Used only for shard
 * partitioning — the only guarantees we rely on are determinism and a roughly
 * uniform distribution over the URL space.
 */
export function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // Equivalent to `hash *= 16777619` but stays in uint32 range.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/**
 * True when this shard owns `url`. Single-shard configs (count<=1) own
 * everything; otherwise ownership is `hash(url) % count === index`.
 */
export function shardOwns(url: string, shardIndex: number, shardCount: number): boolean {
  if (shardCount <= 1) return true;
  return fnv1a(url) % shardCount === shardIndex;
}

/**
 * Merge N shard reports into one. Pages are deduplicated by URL (first-seen
 * wins), actions concatenated, error clusters re-merged by stable key with
 * counts summed and url/invariantName sets unioned. Scalars (duration,
 * blockedExternalNavigations, recoveryCount) fold as makes physical sense:
 * counts sum, duration is max-end minus min-start (wall-clock).
 */
export function mergeReports(reports: readonly CrawlReport[]): CrawlReport {
  if (reports.length === 0) {
    throw new Error("mergeReports: at least one report is required");
  }
  if (reports.length === 1) {
    return { ...reports[0]! };
  }

  const first = reports[0]!;

  const pageByUrl = new Map<string, PageResult>();
  const actions: ActionResult[] = [];
  let blockedExternalNavigations = 0;
  let recoveryCount = 0;
  let startTime = first.startTime;
  let endTime = first.endTime;

  // Discovery metrics — unioned across shards.
  const deadLinkKey = (u: string, s: string | undefined) => `${u}|${s ?? ""}`;
  const deadLinks = new Map<string, DiscoveryMetrics["deadLinks"][number]>();
  const spaIssues = new Map<string, DiscoveryMetrics["spaIssues"][number]>();
  let extractedLinks = 0;
  let clickedLinks = 0;

  for (const r of reports) {
    for (const p of r.pages) {
      if (!pageByUrl.has(p.url)) pageByUrl.set(p.url, p);
    }
    actions.push(...r.actions);
    blockedExternalNavigations += r.blockedExternalNavigations;
    recoveryCount += r.recoveryCount;
    if (r.startTime < startTime) startTime = r.startTime;
    if (r.endTime > endTime) endTime = r.endTime;

    const disc = r.summary.discovery;
    if (disc) {
      extractedLinks += disc.extractedLinks;
      clickedLinks += disc.clickedLinks;
      for (const dl of disc.deadLinks) {
        deadLinks.set(deadLinkKey(dl.url, dl.sourceUrl), dl);
      }
      for (const si of disc.spaIssues) {
        spaIssues.set(`${si.url}|${si.type}|${si.message}`, si);
      }
    }
  }

  const mergedPages = [...pageByUrl.values()];
  const discovery: DiscoveryMetrics = {
    extractedLinks,
    clickedLinks,
    uniquePages: mergedPages.length,
    deadLinks: [...deadLinks.values()],
    spaIssues: [...spaIssues.values()],
  };
  const summary = summarizePages(mergedPages, discovery);

  // Error clusters are recomputed directly from the merged page list so
  // they stay consistent with `pages` / `totalErrors` after URL dedup. If a
  // duplicate `baseUrl` copy is dropped, its errors are gone too and must
  // not reappear as phantom clusters.
  const errorClusters = clusterErrors(mergedPages.flatMap((p) => p.errors));

  // Merge fault-injection stats by rule name.
  const faultByRule = new Map<string, FaultInjectionStats>();
  for (const r of reports) {
    for (const f of r.faultInjections ?? []) {
      const existing = faultByRule.get(f.rule);
      if (existing) {
        existing.matched += f.matched;
        existing.injected += f.injected;
      } else {
        faultByRule.set(f.rule, { ...f });
      }
    }
  }
  const faultInjections = faultByRule.size > 0 ? [...faultByRule.values()] : undefined;

  const totalErrors = mergedPages.reduce((sum, p) => sum + p.errors.length, 0);
  const totalWarnings = mergedPages.reduce((sum, p) => sum + p.warnings.length, 0);

  return {
    baseUrl: first.baseUrl,
    seed: first.seed,
    reproCommand: first.reproCommand,
    startTime,
    endTime,
    duration: endTime - startTime,
    pagesVisited: mergedPages.length,
    totalErrors,
    totalWarnings,
    blockedExternalNavigations,
    recoveryCount,
    pages: mergedPages,
    actions,
    summary,
    faultInjections,
    errorClusters,
    har: first.har,
    diff: undefined,
    // Rebuilt from the merged pages, like the clusters: a per-shard summary
    // cannot be added up (percentiles do not sum).
    perf: buildCrawlPerfSummary(mergedPages, actions, { settle: agreedSettle(reports) }),
  };
}

/**
 * The settle mode every shard recorded, or undefined when any shard did not
 * record one or two disagree: a merged report must not claim one mode for
 * spans measured under another, and `perf regress` treats a missing mode as
 * unknown (a warning), not as a match.
 */
function agreedSettle(reports: readonly CrawlReport[]): PerfSettleRecord | undefined {
  const modes = reports.map((r) => r.perf?.settle);
  const first = modes[0];
  if (!first) return undefined;
  const same = (m: PerfSettleRecord | undefined) => m !== undefined && JSON.stringify(m) === JSON.stringify(first);
  return modes.every(same) ? first : undefined;
}

/**
 * Parse `--shard i/N` (or the pair --shard-index / --shard-count) into
 * { shardIndex, shardCount }. Throws with a named message on bad input.
 */
export function parseShardArg(value: string): { shardIndex: number; shardCount: number } {
  const m = value.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) {
    throw new Error(
      `chaosbringer: --shard must be in the form "<index>/<count>" (got ${JSON.stringify(value)})`
    );
  }
  const shardIndex = Number(m[1]);
  const shardCount = Number(m[2]);
  if (shardCount < 1) {
    throw new Error(`chaosbringer: --shard count must be >= 1 (got ${shardCount})`);
  }
  if (shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error(
      `chaosbringer: --shard index ${shardIndex} out of range [0, ${shardCount})`
    );
  }
  return { shardIndex, shardCount };
}

/** Parsed CLI arguments for the shard coordinator. */
export interface ShardCliArgs {
  count: number;
  output: string;
  compact: boolean;
  quiet: boolean;
  strict: boolean;
  baselineStrict: boolean;
  forward: string[];
}

/**
 * Split off what the coordinator reads itself (--count, --output, --help) and
 * forward the rest to each worker unchanged. Null after printing --help.
 * Exported for tests; `checkWorkerArgs` checks what is forwarded.
 */
export function parseShardCliArgs(argv: string[]): ShardCliArgs | null {
  const forward: string[] = [];
  let count: number | null = null;
  let output = "chaos-report.json";
  let compact = false;
  let quiet = false;
  let strict = false;
  let baselineStrict = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--count" || a === "--shards") {
      const v = argv[++i];
      if (!v) throw new UsageError(`${a} requires a value`);
      count = Number(v);
      continue;
    }
    if (a.startsWith("--count=") || a.startsWith("--shards=")) {
      count = Number(a.split("=")[1]);
      continue;
    }
    if (a === "--output" || a === "-o") {
      const v = argv[++i];
      if (!v) throw new UsageError("--output requires a value");
      output = v;
      continue;
    }
    if (a.startsWith("--output=")) {
      output = a.slice("--output=".length);
      continue;
    }
    if (a === "--compact") {
      compact = true;
      forward.push(a);
      continue;
    }
    if (a === "--quiet") {
      quiet = true;
      forward.push(a);
      continue;
    }
    if (a === "--strict") {
      strict = true;
      forward.push(a);
      continue;
    }
    if (a === "--baseline-strict") {
      baselineStrict = true;
      forward.push(a);
      continue;
    }
    if (a === "--help" || a === "-h") {
      printShardHelp();
      return null;
    }
    forward.push(a);
  }

  if (count === null || !Number.isFinite(count) || !Number.isInteger(count) || count < 1) {
    throw new UsageError("--count <N> is required and must be an integer >= 1");
  }

  return { count, output, compact, quiet, strict, baselineStrict, forward };
}

/**
 * Refuse, before any worker starts, the arguments every worker would refuse,
 * by the main crawl's own option table and checks. An unknown flag used to
 * be forwarded, refused by each of the N workers, and end in `could not read
 * …/shard-0.json` and exit 1. Returns the seed the workers share: the one
 * given, or a fresh one, so that every shard runs with it and the merged
 * report's seed and Repro line hold for the whole run.
 */
export async function checkWorkerArgs(args: ShardCliArgs): Promise<number> {
  // Imported on demand, like perf-cli in cli.ts: the library's
  // `mergeReports` / `shardOwns` import this module, and cli-crawl-options
  // imports `parseShardArg` from it.
  const { crawlCliExtras, crawlerOptionsFromCli, crawlUrlFromArgs, parseCrawlArgs, readCrawlPerfBudgets } = await import(
    "./cli-crawl-options.js"
  );
  const { validateOptions } = await import("./validate.js");
  try {
    // The main CLI's checks, in its order, so whatever a worker would refuse
    // before its browser starts is refused here, once.
    const { values, positionals } = parseCrawlArgs([...args.forward, "--shard", `0/${args.count}`]);
    const options = crawlerOptionsFromCli(values, crawlUrlFromArgs(values, positionals));
    crawlCliExtras(values);
    const budgets = await readCrawlPerfBudgets(values, options.settle);
    if (budgets?.refusal) throw new UsageError(budgets.refusal.message);
    if (budgets) options.perfBudgets = budgets.rules;
    validateOptions(options);
    return options.seed ?? randomSeed();
  } catch (err) {
    throw isUsageError(err) ? err : new UsageError(errorMessage(err));
  }
}

/**
 * The command that reruns the whole sharded run: a worker's Repro line with
 * `chaosbringer shard --count N` for its `--shard i/N`. Every worker ran
 * with the same flags and seed, so any one of them stands for the rest. The
 * merged report used to keep shard 0's line, which reran shard 0 alone.
 */
export function shardReproCommand(workerRepro: string, count: number): string {
  return workerRepro
    .replace(/^chaosbringer /, `chaosbringer shard --count ${count} `)
    .replace(/ --shard \d+\/\d+(?= |$)/, "");
}

function printShardHelp(): void {
  console.log(`
chaosbringer shard — run N crawlers in parallel and merge their reports.

USAGE:
  chaosbringer shard --count <N> --url <url> [options]

OPTIONS:
  --count <N>           Number of shards (required, >= 1)
  --output <path>       Merged report output (default: chaos-report.json)
  --help                Show this help

All other options are the main crawl's (chaosbringer --help), checked before
any worker starts and forwarded verbatim to each shard worker (e.g. --url,
--max-pages, --seed, --seed-from-sitemap, --baseline, --strict). Each worker
receives an additional --shard i/N flag, and the same --seed: the given one,
or one drawn for the run. --quiet and --compact print the merged report the
way the main command prints its own, without the workers' output but with
the paths they wrote (failure bundles, --trace-out, --log-file, ...).

For full URL-space coverage, combine with --seed-from-sitemap: each shard
filters the sitemap URLs by hash so every URL is processed by exactly one
shard. Without a sitemap, each shard explores the subgraph reachable from
owned links — some pages may go unvisited.
`);
}

/**
 * The lines of the main CLI's output that name a file or directory it wrote,
 * in the order it prints them, but its `Report saved to:`: a worker's report
 * is a temp file, which the merged report replaces.
 */
const WORKER_PATH_LINES = [
  /^Heatmap saved to: /,
  /^Wrote \d+ failure bundle\(s\) to /,
  /^Trace saved to: /,
  /^Log saved to: /,
  /^Wrote \d+ cluster bundle\(s\) to /,
  /^JUnit XML saved to: /,
];

/**
 * The paths the silenced workers wrote, from their stdout, merged in the main
 * CLI's order: a directory's bundle counts summed (each worker counts its
 * own; the base URL, which every shard crawls, counts once per shard that
 * bundled it), any other line once.
 */
export function mergeWorkerPaths(outputs: readonly string[]): string[] {
  const merged = new Map<string, { rank: number; count?: number }>();
  for (const output of outputs) {
    for (const line of output.split("\n")) {
      const rank = WORKER_PATH_LINES.findIndex((re) => re.test(line));
      if (rank < 0) continue;
      const bundles = /^Wrote (\d+) (.+)$/.exec(line);
      if (bundles?.[1] !== undefined && bundles[2] !== undefined) {
        const count = (merged.get(bundles[2])?.count ?? 0) + Number(bundles[1]);
        merged.set(bundles[2], { rank, count });
      } else if (!merged.has(line)) {
        merged.set(line, { rank });
      }
    }
  }
  return [...merged]
    .sort(([, a], [, b]) => a.rank - b.rank)
    .map(([line, { count }]) => (count === undefined ? line : `Wrote ${count} ${line}`));
}

/**
 * Spawn one worker and resolve with {exitCode, reportPath}, and with what it
 * printed when `quiet` keeps that off the terminal.
 */
function runShardWorker(args: {
  nodeBin: string;
  scriptPath: string;
  execArgv: readonly string[];
  workerArgs: readonly string[];
  reportPath: string;
  quiet: boolean;
  index: number;
}): Promise<{ exitCode: number; reportPath: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      args.nodeBin,
      [...args.execArgv, args.scriptPath, ...args.workerArgs],
      {
        stdio: args.quiet ? ["ignore", "pipe", "inherit"] : "inherit",
        env: { ...process.env, CHAOS_SHARD_INDEX: String(args.index) },
      }
    );
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    // `close`, not `exit`: the stdout pipe may still hold the last lines.
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, reportPath: args.reportPath, stdout });
    });
    child.on("error", (err) => {
      console.error(`shard ${args.index}: spawn failed — ${err.message}`);
      resolve({ exitCode: 1, reportPath: args.reportPath, stdout });
    });
  });
}

/**
 * Entry point for the `shard` subcommand. Wired from src/cli.ts. Sets
 * `process.exitCode` rather than exiting: a `process.exit` inside the `try`
 * skipped the `finally`, and every run left its /tmp/chaos-shard-* behind.
 */
export async function runShardCli(argv: string[]): Promise<void> {
  const args = parseShardCliArgs(argv);
  if (!args) return;
  const seed = await checkWorkerArgs(args);
  const workdir = mkdtempSync(join(tmpdir(), "chaos-shard-"));

  try {
    const nodeBin = process.execPath;
    const scriptPath = process.argv[1] ?? "";
    const execArgv = process.execArgv;

    if (!args.quiet) {
      console.log(`Running ${args.count} shard(s) in parallel...`);
    }

    // --compact shows the merged report: N workers' progress lines and
    // compact reports, interleaved, are not that.
    const silenced = args.quiet || args.compact;
    const workers = Array.from({ length: args.count }, (_, i) => {
      const reportPath = join(workdir, `shard-${i}.json`);
      // A later --seed wins in parseArgs, so this is the given one or the
      // fresh one checkWorkerArgs drew: unseeded, each worker used to draw
      // its own, and no seed reran the run.
      const workerArgs = [
        ...args.forward,
        "--seed",
        String(seed),
        "--shard",
        `${i}/${args.count}`,
        "--output",
        reportPath,
      ];
      return runShardWorker({
        nodeBin,
        scriptPath,
        execArgv,
        workerArgs,
        reportPath,
        quiet: silenced,
        index: i,
      });
    });

    const results = await Promise.all(workers);

    const reports: CrawlReport[] = [];
    for (const r of results) {
      try {
        const raw = readFileSync(r.reportPath, "utf-8");
        reports.push(JSON.parse(raw) as CrawlReport);
      } catch (err) {
        console.error(
          `shard: could not read ${r.reportPath} — ${(err as Error).message}`
        );
      }
    }

    if (reports.length === 0) {
      console.error("shard: no reports produced — aborting");
      process.exitCode = 1;
      return;
    }

    const merged = mergeReports(reports);
    if (merged.reproCommand) merged.reproCommand = shardReproCommand(merged.reproCommand, args.count);

    // Persist merged report.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(args.output, JSON.stringify(merged, null, 2));

    // The main CLI's output modes: --quiet is the verdict, why it failed
    // and the paths written. It printed the whole merged report.
    const exitOptions = { strict: args.strict, baselineStrict: args.baselineStrict };
    if (args.quiet) console.log(formatQuietReport(merged, exitOptions));
    else printReport(merged, args.compact, exitOptions);
    const announce = (line: string) => console.log(args.quiet ? line : `\n${line}`);
    // The silenced workers' bundles, trace, log, … had no line at all.
    if (silenced) for (const line of mergeWorkerPaths(results.map((r) => r.stdout))) announce(line);
    announce(`Merged report saved to: ${args.output}`);
    const failed = results.filter((r) => r.exitCode !== 0).length;
    if (failed > 0) {
      console.log(`${failed}/${args.count} shard(s) exited non-zero`);
    }

    // Exit code: max of (any shard non-zero) and (merged report's getExitCode).
    const reportExit = getExitCode(merged, exitOptions);
    const workerExit = failed > 0 ? 1 : 0;
    process.exitCode = Math.max(reportExit, workerExit);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}
