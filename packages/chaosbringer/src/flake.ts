/**
 * Flake detection. Runs chaos N times with the same seed and reports which
 * error clusters are stable (fire in every run) vs flaky (fire in some but
 * not all). Useful for triaging whether a failure is real or a race.
 *
 * The analysis itself is a pure function over CrawlReports; orchestration
 * (running chaos N times + pretty-printing) is layered on top so tests can
 * exercise the analysis without a browser.
 */

import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
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
export function flakeReport(reports: readonly CrawlReport[]): FlakeAnalysis {
  const runs = reports.length;
  if (runs === 0) {
    return { runs: 0, stableClusters: [], flakyClusters: [], flakyPages: [], durations: [] };
  }

  const keyMap = new Map<string, ClusterOccurrence>();
  reports.forEach((report, idx) => {
    for (const cluster of report.errorClusters) {
      let occ = keyMap.get(cluster.key);
      if (!occ) {
        occ = {
          key: cluster.key,
          type: cluster.type,
          fingerprint: cluster.fingerprint,
          perRunCounts: Array(runs).fill(0),
          runsWithCluster: 0,
        };
        keyMap.set(cluster.key, occ);
      }
      occ.perRunCounts[idx] = cluster.count;
    }
  });
  for (const occ of keyMap.values()) {
    occ.runsWithCluster = occ.perRunCounts.filter((c) => c > 0).length;
  }

  const stableClusters: ClusterOccurrence[] = [];
  const flakyClusters: ClusterOccurrence[] = [];
  for (const occ of keyMap.values()) {
    if (occ.runsWithCluster === runs) stableClusters.push(occ);
    else if (occ.runsWithCluster > 0) flakyClusters.push(occ);
  }
  stableClusters.sort((a, b) => b.perRunCounts.reduce((x, y) => x + y, 0) - a.perRunCounts.reduce((x, y) => x + y, 0));
  flakyClusters.sort((a, b) => b.runsWithCluster - a.runsWithCluster);

  const pageFailedSet = new Map<string, { failed: boolean[]; visited: boolean[] }>();
  reports.forEach((report, idx) => {
    for (const page of report.pages) {
      let rec = pageFailedSet.get(page.url);
      if (!rec) {
        rec = { failed: Array(runs).fill(false), visited: Array(runs).fill(false) };
        pageFailedSet.set(page.url, rec);
      }
      rec.visited[idx] = true;
      const isFailed =
        page.errors.length > 0 || page.status === "error" || page.status === "timeout";
      rec.failed[idx] = isFailed;
    }
  });

  const flakyPages: PageOccurrence[] = [];
  for (const [url, rec] of pageFailedSet) {
    const failedInRuns = rec.failed.filter(Boolean).length;
    const visitedInRuns = rec.visited.filter(Boolean).length;
    // Only flag as flaky if the URL was visited in more than one run and
    // its outcome differs across those visits.
    if (visitedInRuns >= 2 && failedInRuns > 0 && failedInRuns < visitedInRuns) {
      flakyPages.push({ url, failedInRuns, visitedInRuns });
    }
  }
  flakyPages.sort((a, b) => b.failedInRuns - a.failedInRuns);

  return {
    runs,
    stableClusters,
    flakyClusters,
    flakyPages,
    durations: reports.map((r) => r.duration),
  };
}

export function formatFlakeReport(analysis: FlakeAnalysis): string {
  const lines: string[] = [];
  lines.push("=".repeat(60));
  lines.push(`FLAKE REPORT — ${analysis.runs} runs`);
  lines.push("=".repeat(60));
  if (analysis.durations.length > 0) {
    const min = Math.min(...analysis.durations);
    const max = Math.max(...analysis.durations);
    const avg = analysis.durations.reduce((a, b) => a + b, 0) / analysis.durations.length;
    lines.push(`Duration (ms): avg=${avg.toFixed(0)} min=${min} max=${max}`);
  }
  lines.push("");
  lines.push(`Stable clusters (fire every run): ${analysis.stableClusters.length}`);
  for (const c of analysis.stableClusters) {
    lines.push(`  [${c.type}] ${truncate(c.fingerprint, 70)}  counts=${c.perRunCounts.join(",")}`);
  }
  lines.push("");
  lines.push(`Flaky clusters (fire in some runs): ${analysis.flakyClusters.length}`);
  for (const c of analysis.flakyClusters) {
    lines.push(
      `  [${c.type}] ${truncate(c.fingerprint, 70)}  runs=${c.runsWithCluster}/${analysis.runs}  counts=${c.perRunCounts.join(",")}`
    );
  }
  lines.push("");
  lines.push(`Flaky pages (outcome varies across runs): ${analysis.flakyPages.length}`);
  for (const p of analysis.flakyPages) {
    lines.push(`  ${p.url}  failed=${p.failedInRuns}/${p.visitedInRuns}`);
  }
  lines.push("");
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 3) + "...";
}

interface FlakeCliArgs {
  baseUrl: string;
  runs: number;
  seed?: number;
  maxPages?: number;
  maxActions?: number;
  timeout?: number;
  ignoreAnalytics: boolean;
  harReplay?: string;
  traceReplay?: string;
  storageState?: string;
  output?: string;
  quiet: boolean;
}

function parseFlakeArgs(argv: string[]): FlakeCliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: "string" },
      runs: { type: "string" },
      seed: { type: "string" },
      "max-pages": { type: "string" },
      "max-actions": { type: "string" },
      timeout: { type: "string" },
      "ignore-analytics": { type: "boolean", default: false },
      "har-replay": { type: "string" },
      "trace-replay": { type: "string" },
      "storage-state": { type: "string" },
      output: { type: "string" },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printFlakeHelp();
    process.exit(0);
  }
  if (!values.url) fail("--url is required");

  const runs = values.runs ? Number(values.runs) : 3;
  if (!Number.isFinite(runs) || !Number.isInteger(runs) || runs < 2) {
    fail(`--runs must be an integer >= 2 (got ${JSON.stringify(values.runs)})`);
  }

  let seed: number | undefined;
  if (values.seed !== undefined) {
    const parsed = Number(values.seed);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
      fail(`--seed must be a non-negative integer (got ${JSON.stringify(values.seed)})`);
    }
    seed = parsed;
  }

  return {
    baseUrl: values.url!,
    runs,
    seed,
    maxPages: values["max-pages"] ? Number(values["max-pages"]) : undefined,
    maxActions: values["max-actions"] ? Number(values["max-actions"]) : undefined,
    timeout: values.timeout ? Number(values.timeout) : undefined,
    ignoreAnalytics: values["ignore-analytics"] ?? false,
    harReplay: values["har-replay"],
    traceReplay: values["trace-replay"],
    storageState: values["storage-state"],
    output: values.output,
    quiet: values.quiet ?? false,
  };
}

function printFlakeHelp(): void {
  console.log(`
chaosbringer flake — run the same crawl N times and surface flaky errors.

USAGE:
  chaosbringer flake --url <url> [--runs N] [options]

OPTIONS:
  --url <url>           Base URL (required)
  --runs <n>            Number of runs (default: 3, minimum: 2)
  --seed <n>            Fixed seed — makes RNG-driven variance impossible,
                        so any flake points at non-determinism outside
                        chaosbringer (server, network, timers).
  --max-pages <n>       Forward to each crawl
  --max-actions <n>     Forward to each crawl
  --timeout <ms>        Forward to each crawl
  --ignore-analytics    Forward to each crawl
  --har-replay <path>   Forward to each crawl
  --trace-replay <path> Forward to each crawl
  --storage-state <p>   Forward to each crawl
  --output <path>       Write the flake analysis as JSON alongside stdout
  --quiet               Print only the final summary
  --help                Show this help
`);
}

function fail(msg: string): never {
  console.error(`Error: ${msg}`);
  console.error("Run `chaosbringer flake --help` for usage information.");
  process.exit(1);
}

/** Entry point wired from src/cli.ts when the `flake` subcommand is used. */
export async function runFlakeCli(argv: string[]): Promise<void> {
  const args = parseFlakeArgs(argv);
  const { ChaosCrawler, COMMON_IGNORE_PATTERNS } = await import("./crawler.js");
  const reports: CrawlReport[] = [];
  for (let i = 0; i < args.runs; i++) {
    if (!args.quiet) console.log(`Run ${i + 1}/${args.runs}...`);
    const crawler = new ChaosCrawler({
      baseUrl: args.baseUrl,
      seed: args.seed,
      maxPages: args.maxPages,
      maxActionsPerPage: args.maxActions,
      timeout: args.timeout,
      ignoreErrorPatterns: args.ignoreAnalytics ? COMMON_IGNORE_PATTERNS : undefined,
      har: args.harReplay ? { path: args.harReplay, mode: "replay" } : undefined,
      traceReplay: args.traceReplay,
      storageState: args.storageState,
    });
    const report = await crawler.start();
    reports.push(report);
  }
  const analysis = flakeReport(reports);
  console.log(formatFlakeReport(analysis));
  if (args.output) {
    writeFileSync(args.output, JSON.stringify(analysis, null, 2));
    if (!args.quiet) console.log(`Analysis saved to: ${args.output}`);
  }
  // Exit 1 if anything flaked — CI uses this to fail a gate.
  if (analysis.flakyClusters.length > 0 || analysis.flakyPages.length > 0) {
    process.exit(1);
  }
}
