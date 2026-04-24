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
import { parseArgs } from "node:util";
import { clusterErrors } from "./clusters.js";
import { summarizePages } from "./filters.js";
import { printReport, getExitCode } from "./reporter.js";
import type {
  ActionResult,
  CrawlReport,
  DiscoveryMetrics,
  FaultInjectionStats,
  PageResult,
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
  };
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
interface ShardCliArgs {
  count: number;
  output: string;
  compact: boolean;
  quiet: boolean;
  strict: boolean;
  baselineStrict: boolean;
  forward: string[];
}

function parseShardCliArgs(argv: string[]): ShardCliArgs {
  // First, split off --count / --output / --help, forward the rest to each
  // child unchanged. We deliberately do NOT re-validate --url etc here; the
  // child CLI handles that and errors propagate.
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
      if (!v) throw new Error(`chaosbringer shard: ${a} requires a value`);
      count = Number(v);
      continue;
    }
    if (a.startsWith("--count=") || a.startsWith("--shards=")) {
      count = Number(a.split("=")[1]);
      continue;
    }
    if (a === "--output" || a === "-o") {
      const v = argv[++i];
      if (!v) throw new Error("chaosbringer shard: --output requires a value");
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
      process.exit(0);
    }
    forward.push(a);
  }

  if (count === null || !Number.isFinite(count) || !Number.isInteger(count) || count < 1) {
    throw new Error("chaosbringer shard: --count <N> is required and must be an integer >= 1");
  }

  return { count, output, compact, quiet, strict, baselineStrict, forward };
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

All other options are forwarded verbatim to each shard worker (e.g. --url,
--max-pages, --seed, --seed-from-sitemap, --baseline, --strict, --compact,
--quiet). Each worker receives an additional --shard i/N flag.

For full URL-space coverage, combine with --seed-from-sitemap: each shard
filters the sitemap URLs by hash so every URL is processed by exactly one
shard. Without a sitemap, each shard explores the subgraph reachable from
owned links — some pages may go unvisited.
`);
}

/** Spawn one worker and resolve with {exitCode, reportPath}. */
function runShardWorker(args: {
  nodeBin: string;
  scriptPath: string;
  execArgv: readonly string[];
  workerArgs: readonly string[];
  reportPath: string;
  quiet: boolean;
  index: number;
}): Promise<{ exitCode: number; reportPath: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      args.nodeBin,
      [...args.execArgv, args.scriptPath, ...args.workerArgs],
      {
        stdio: args.quiet ? ["ignore", "ignore", "inherit"] : "inherit",
        env: { ...process.env, CHAOS_SHARD_INDEX: String(args.index) },
      }
    );
    child.on("exit", (code) => {
      resolve({ exitCode: code ?? 1, reportPath: args.reportPath });
    });
    child.on("error", (err) => {
      console.error(`shard ${args.index}: spawn failed — ${err.message}`);
      resolve({ exitCode: 1, reportPath: args.reportPath });
    });
  });
}

/** Entry point for the `shard` subcommand. Wired from src/cli.ts. */
export async function runShardCli(argv: string[]): Promise<void> {
  const args = parseShardCliArgs(argv);
  const workdir = mkdtempSync(join(tmpdir(), "chaos-shard-"));

  try {
    const nodeBin = process.execPath;
    const scriptPath = process.argv[1] ?? "";
    const execArgv = process.execArgv;

    if (!args.quiet) {
      console.log(`Running ${args.count} shard(s) in parallel...`);
    }

    const workers = Array.from({ length: args.count }, (_, i) => {
      const reportPath = join(workdir, `shard-${i}.json`);
      const workerArgs = [
        ...args.forward,
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
        quiet: args.quiet,
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
      process.exit(1);
    }

    const merged = mergeReports(reports);

    // Persist merged report.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(args.output, JSON.stringify(merged, null, 2));

    const exitOptions = { strict: args.strict, baselineStrict: args.baselineStrict };
    printReport(merged, args.compact, exitOptions);
    if (!args.quiet) {
      console.log(`\nMerged report saved to: ${args.output}`);
      const failed = results.filter((r) => r.exitCode !== 0).length;
      if (failed > 0) {
        console.log(`${failed}/${args.count} shard(s) exited non-zero`);
      }
    }

    // Exit code: max of (any shard non-zero) and (merged report's getExitCode).
    const reportExit = getExitCode(merged, exitOptions);
    const workerExit = results.some((r) => r.exitCode !== 0) ? 1 : 0;
    process.exit(Math.max(reportExit, workerExit));
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}
