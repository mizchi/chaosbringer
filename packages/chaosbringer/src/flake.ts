/**
 * Flake detection. Runs chaos N times with the same seed and reports which
 * error clusters are stable (fire in every run) vs flaky (fire in some but
 * not all). Useful for triaging whether a failure is real or a race.
 *
 * The analysis itself is a pure function over CrawlReports; orchestration
 * (running chaos N times + pretty-printing) is layered on top so tests can
 * exercise the analysis without a browser.
 */

import { writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import {
  asUsageError,
  baselineMissingFromCli,
  CRAWL_CLI_OPTIONS,
  type CrawlCliValues,
  crawlCliExtras,
  crawlCliPeerNeeds,
  type CrawlFlag,
  crawlerOptionsFromCli,
  crawlUrlFromArgs,
  exitOptionsFromCli,
  formatFlagList,
  parseArgsSuggesting,
  readCrawlPerfBudgets,
} from "./cli-crawl-options.js";
import { UsageError } from "./cli-usage.js";
import { type ExitCodeOptions, exitReasons } from "./reporter.js";
import { isFaultEcho } from "./resource-outcomes.js";
import { applyBaseline, mergeRunWarnings, type RunWarning, warningTimes } from "./run-warnings.js";
import type { CrawlerOptions, CrawlReport, PageError } from "./types.js";
import { UnreachableTargetError, unreachableTarget } from "./unreachable-target.js";
import { validateOptions } from "./validate.js";

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

/** One run's verdict under the crawl's exit rules (`getExitCode`). */
export interface RunVerdict {
  /** The seed the run crawled with. */
  seed: number;
  passed: boolean;
  /** Why it failed (`exitReasons`), empty when it passed. */
  reasons: string[];
}

export interface FlakeAnalysis {
  runs: number;
  /**
   * Whether `runs` was enough to decide anything about flakiness at all. Two
   * is the minimum, and below it every field lies in the reassuring direction:
   * with one run each cluster fired in "every" run, so `flakyClusters` is
   * empty *by construction* and `stableClusters` calls a cluster seen exactly
   * once stable. With zero runs everything is empty.
   *
   * Both read identically to a clean result, which is why this flag exists
   * rather than a comment: the CLI turns `flakyClusters.length === 0` into a
   * green CI gate, and a gate that passes because nothing was measured is the
   * one outcome this tool must never produce. (`flakyPages` already required
   * `visitedInRuns >= 2` for the same reason — the guard existed on the
   * quieter half of the report and not on the headline.)
   */
  decidable: boolean;
  /**
   * Each run's verdict, in run order, by the exit rules the crawl applies
   * with the same flags (`flakeReport`'s `exitRules`: `--strict`, the
   * `--fail-on-*` gates, `--baseline-strict`).
   */
  verdicts: RunVerdict[];
  /**
   * Some runs passed and some failed under those rules: the run's own
   * outcome is not reproducible. Never set without `decidable`.
   */
  verdictFlaky: boolean;
  /** Clusters that fired in every run. Stability is only a claim when `decidable`. */
  stableClusters: ClusterOccurrence[];
  /** Clusters that fired in some runs but not others. */
  flakyClusters: ClusterOccurrence[];
  /** Pages whose failed/clean state differed across runs. */
  flakyPages: PageOccurrence[];
  /** Per-run duration in ms, in input order. */
  durations: number[];
  /**
   * The runs' warnings (`CrawlReport.warnings`), identical ones folded across
   * runs, their counts added: what made the runs test less than asked.
   */
  warnings: RunWarning[];
}

/**
 * Given N CrawlReports from runs of the same configuration, separate the
 * error clusters into stable (always fire) vs flaky (inconsistent), and the
 * pages into flaky (different failed/clean outcomes) vs stable. Each run is
 * also judged by `exitRules`, the rules the crawl exits by (`getExitCode`'s
 * second argument; the CLI passes what its flags ask for), and the verdict
 * is flaky when the runs disagree.
 */
export function flakeReport(reports: readonly CrawlReport[], exitRules: boolean | ExitCodeOptions = {}): FlakeAnalysis {
  const runs = reports.length;
  // One run is enough to *list* what happened and never enough to call any of
  // it stable or flaky, so the verdict is marked undecidable rather than
  // returned as a clean bill of health.
  const decidable = runs >= 2;
  if (runs === 0) {
    return {
      runs: 0,
      decidable,
      verdicts: [],
      verdictFlaky: false,
      stableClusters: [],
      flakyClusters: [],
      flakyPages: [],
      durations: [],
      warnings: [],
    };
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
      // The echo of a fault the run injected is not the page failing, as in
      // diff.ts: a probability fault would make every page it hit "flaky".
      const isFailed =
        page.errors.some((e) => !isFaultEcho(e)) || page.status === "error" || page.status === "timeout";
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

  const verdicts = reports.map((report): RunVerdict => {
    const reasons = exitReasons(report, exitRules);
    return { seed: report.seed, passed: reasons.length === 0, reasons };
  });
  const passed = verdicts.filter((v) => v.passed).length;

  return {
    runs,
    decidable,
    verdicts,
    verdictFlaky: decidable && passed > 0 && passed < runs,
    stableClusters,
    flakyClusters,
    flakyPages,
    durations: reports.map((r) => r.duration),
    warnings: mergeRunWarnings(reports.map((r) => r.warnings)),
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
  if (!analysis.decidable) {
    lines.push(
      `UNDECIDABLE — flakiness needs at least 2 runs of the same configuration; ` +
        `this analysis has ${analysis.runs}.`,
    );
    lines.push(
      `  With one run nothing can differ between runs, so "0 flaky clusters" below is a ` +
        `property of the sample size and not of the app. Re-run with --runs 2 or more.`,
    );
    lines.push("");
  }
  // Older analyses (a `--output` file read back) have no verdicts.
  const verdicts = analysis.verdicts ?? [];
  if (verdicts.length > 0) {
    const failed = verdicts.filter((v) => !v.passed).length;
    const summary =
      failed === 0
        ? "every run passed"
        : failed === verdicts.length
          ? "every run failed"
          : `${verdicts.length - failed} passed, ${failed} failed`;
    lines.push(`Verdicts (the crawl's exit rules): ${summary}${analysis.verdictFlaky ? " — FLAKY" : ""}`);
    verdicts.forEach((v, i) => {
      if (!v.passed) lines.push(`  run ${i + 1} (seed=${v.seed}) FAIL: ${v.reasons.join("; ")}`);
    });
    lines.push("");
  }
  lines.push(
    analysis.decidable
      ? `Stable clusters (fire every run): ${analysis.stableClusters.length}`
      : `Clusters seen (stability undecidable): ${analysis.stableClusters.length}`,
  );
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
  // Once, however many runs raised each.
  const warnings = analysis.warnings ?? [];
  if (warnings.length > 0) {
    lines.push(`Warnings (the runs tested less than they were set up to): ${warnings.length}`);
    for (const w of warnings) lines.push(`  [${w.code}] ${w.message}${warningTimes(w)}`);
    lines.push("");
  }
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 3) + "...";
}

/** `flake`'s own flags. Every other flag is the main crawl's (`CRAWL_CLI_OPTIONS`). */
const FLAKE_OPTIONS = {
  runs: { type: "string" },
  output: { type: "string" },
  quiet: { type: "boolean", default: false },
  help: { type: "boolean", short: "h", default: false },
} as const;
const FLAKE_OWN_FLAGS: readonly string[] = Object.keys(FLAKE_OPTIONS);

/**
 * Crawl flags flake accepts and does not apply: each writes or formats one
 * crawl's report, after the crawl, and flake writes none (its analysis goes
 * to stdout and `--output`). Accepted so that a CI command pasted after `--`
 * runs; a stderr line names the ones given.
 */
export const FLAKE_NOT_APPLIED: readonly CrawlFlag[] = [
  "compact",
  "heatmap",
  "heatmap-top",
  "heatmap-out",
  "junit",
  "github-annotations",
  "cluster-artifacts",
  "cluster-min-count",
  "version",
];

/**
 * Crawl flags naming a file (or, for the last three, a directory) a run
 * writes: each run gets its own, `<name>.run<N><ext>` (or `<dir>/run-<N>`),
 * so the trace of the run that failed is still there for `minimize`, not
 * overwritten by the next run.
 */
export const FLAKE_PER_RUN_OUTPUTS: readonly CrawlFlag[] = [
  "trace-out",
  "har-record",
  "log-file",
  "failure-artifacts",
  "screenshot-dir",
  "perf-out",
];

/** `path` for run `run` (1-based): `t.jsonl` is `t.run2.jsonl`, a directory `dir/run-2`. */
export function perRunPath(path: string, run: number, kind: "file" | "dir"): string {
  if (kind === "dir") return join(path, `run-${run}`);
  const ext = extname(path);
  return `${ext ? path.slice(0, -ext.length) : path}.run${run}${ext}`;
}

/** `options` for run `run`, with every file the run writes its own (`FLAKE_PER_RUN_OUTPUTS`). */
export function perRunOptions(options: CrawlerOptions, run: number): CrawlerOptions {
  const out: CrawlerOptions = { ...options };
  if (options.traceOut) out.traceOut = perRunPath(options.traceOut, run, "file");
  if (options.har?.mode === "record") out.har = { ...options.har, path: perRunPath(options.har.path, run, "file") };
  if (options.logFile) out.logFile = perRunPath(options.logFile, run, "file");
  if (options.failureArtifacts) {
    out.failureArtifacts = { ...options.failureArtifacts, dir: perRunPath(options.failureArtifacts.dir, run, "dir") };
  }
  if (options.screenshotDir) out.screenshotDir = perRunPath(options.screenshotDir, run, "dir");
  if (options.perf && typeof options.perf === "object" && options.perf.outDir !== undefined) {
    out.perf = { ...options.perf, outDir: perRunPath(options.perf.outDir, run, "dir") };
  }
  return out;
}

export interface FlakeCliArgs {
  runs: number;
  output?: string;
  quiet: boolean;
  baseUrl: string;
  /**
   * Every run's crawler options, built from the crawl flags by the main
   * crawl's own builder (`crawlerOptionsFromCli`). Without `--seed` each run
   * draws its own; with one, every run uses it.
   */
  options: CrawlerOptions;
  /** The rules each run is judged by: the ones the crawl would exit by with these flags. */
  exitOptions: ExitCodeOptions;
  /** The crawl flags, as the main crawl parses them. */
  crawl: Partial<CrawlCliValues>;
  /** Given crawl flags that flake does not apply (`FLAKE_NOT_APPLIED`). */
  notApplied: string[];
}

/**
 * The words after `flake … --`: a crawl command as the shell split it, a
 * `Repro:` line pasted as it was printed, its leading `chaosbringer` (or
 * `npx chaosbringer`, `pnpm exec chaosbringer`, a path to the binary)
 * dropped. The quoting `reproCommand` writes is the shell's to undo.
 */
export function pastedCrawlArgs(words: readonly string[]): string[] {
  if (words.length === 1 && /\s/.test(words[0]!)) {
    throw new UsageError(
      "after --: one argument with spaces in it; paste the command unquoted, so the shell splits it into its words",
    );
  }
  let i = 0;
  if (words[0] === "npx" || words[0] === "pnpx" || words[0] === "bunx") {
    i = 1;
    while (words[i] === "-y" || words[i] === "--yes") i++;
  } else if (words[0] === "pnpm" && (words[1] === "exec" || words[1] === "dlx")) {
    i = 2;
  } else if (words[0] === "yarn") {
    i = words[1] === "exec" ? 2 : 1;
  }
  const bin = words[i];
  if (bin !== undefined && /(^|\/)chaosbringer(@[^/\s]*)?$/.test(bin)) return words.slice(i + 1);
  if (i > 0) throw new UsageError(`after --: expected a chaosbringer command, got ${JSON.stringify(words.slice(0, i + 1).join(" "))}`);
  return [...words];
}

/** One flag spelled two ways (`--max-actions-per-page`, `--no-headless`), for the conflict check. */
const FLAG_GROUP: Readonly<Record<string, string>> = {
  "max-actions-per-page": "max-actions",
  "no-headless": "headless",
  "data-safety": "invariants",
};

/**
 * Exported for tests: it is where every refusal is made, and `runFlakeCli`
 * cannot be reached without launching browsers. Every refusal throws: an
 * unknown flag from `parseArgs` (with the flag it misspells, when one is
 * close), an invalid value or a conflict a `UsageError`, which cli.ts
 * reports with exit 2.
 *
 * The crawl flags go before a `--` or after it, as a pasted crawl command.
 * flake's own flags (`--runs`, `--output`, `--quiet`, `--help`) only go
 * before it, and a crawl flag (or the URL) given on both sides is refused:
 * which one would win is a guess either way.
 */
export function parseFlakeArgs(argv: string[]): FlakeCliArgs {
  const split = argv.indexOf("--");
  const ownArgs = split < 0 ? argv : argv.slice(0, split);
  const own = parseArgsSuggesting({
    args: ownArgs,
    options: { ...CRAWL_CLI_OPTIONS, ...FLAKE_OPTIONS },
    allowPositionals: true,
    tokens: true,
  });
  if (own.values.help) {
    printFlakeHelp();
    process.exit(0);
  }
  const given = (tokens: typeof own.tokens) =>
    new Set<string>((tokens ?? []).flatMap((t) => (t.kind === "option" ? [t.name] : [])));
  const ownGiven = given(own.tokens);

  let values: Partial<CrawlCliValues> = own.values;
  let positionals = own.positionals;
  if (split >= 0) {
    const pasted = parseArgsSuggesting({
      args: pastedCrawlArgs(argv.slice(split + 1)),
      // `--runs` parses so that it can be refused as flake's own.
      options: { ...CRAWL_CLI_OPTIONS, runs: FLAKE_OPTIONS.runs },
      allowPositionals: true,
      tokens: true,
    });
    const pastedGiven = given(pasted.tokens);
    for (const name of pastedGiven) {
      if (FLAKE_OWN_FLAGS.includes(name)) {
        throw new UsageError(
          `--${name} after --: flake's own flags (${FLAKE_OWN_FLAGS.map((f) => `--${f}`).join(", ")}) go before the --`,
        );
      }
    }
    const group = (name: string) => FLAG_GROUP[name] ?? name;
    const ownGroups = new Set([...ownGiven].filter((n) => !FLAKE_OWN_FLAGS.includes(n)).map(group));
    if (own.positionals.length > 0) ownGroups.add("url");
    const pastedGroups = [...pastedGiven].map(group);
    if (pasted.positionals.length > 0) pastedGroups.push("url");
    const both = pastedGroups.find((g) => ownGroups.has(g));
    if (both !== undefined) {
      throw new UsageError(`${both === "url" ? "the URL" : `--${both}`} is given both before and after --: give it on one side`);
    }
    // The pasted command's values, then what was given before the `--`.
    const ownCrawl = Object.fromEntries(
      Object.entries(own.values).filter(([k]) => ownGiven.has(k) && !FLAKE_OWN_FLAGS.includes(k)),
    );
    values = { ...pasted.values, ...ownCrawl };
    positionals = [...own.positionals, ...pasted.positionals];
  }

  const runsRaw = own.values.runs;
  const runs = runsRaw ? Number(runsRaw) : 3;
  if (!Number.isFinite(runs) || !Number.isInteger(runs) || runs < 2) {
    throw new UsageError(`--runs must be an integer >= 2 (got ${JSON.stringify(runsRaw)})`);
  }

  // The main crawl's checks, in its order, so a value the crawl would
  // refuse is refused here before Run 1 (where it failed with exit 1, which
  // chaos-flake.yml reads as "flakes were found").
  return asUsageError(() => {
    const baseUrl = crawlUrlFromArgs(values as CrawlCliValues, positionals);
    const options = crawlerOptionsFromCli(values, baseUrl);
    crawlCliExtras(values as CrawlCliValues);
    const exitOptions = exitOptionsFromCli(values);
    validateOptions(options);
    const notApplied = FLAKE_NOT_APPLIED.filter((f) => {
      const v = values[f];
      return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== false;
    }).map((f) => `--${f}`);
    return {
      runs,
      output: own.values.output,
      quiet: own.values.quiet ?? false,
      baseUrl,
      options,
      exitOptions,
      crawl: values,
      notApplied,
    };
  });
}

function printFlakeHelp(): void {
  console.log(`
chaosbringer flake — run the same crawl N times and surface flaky errors.

USAGE:
  chaosbringer flake --url <url> [--runs N] [crawl flags]
  chaosbringer flake [--runs N] -- <a crawl command, e.g. a run's Repro: line>

OPTIONS (flake's own; before any --):
  --runs <n>            Number of runs (default: 3, minimum: 2)
  --output <path>       Write the flake analysis as JSON alongside stdout
  --quiet               Print only the final summary
  --help                Show this help

CRAWL FLAGS:
  Every flag of the main crawl (chaosbringer --help) is taken, before the -- or
  after it, and every run crawls with it: --seed, --exclude, --settle,
  --storage-state, --strict, --invariants, … After a --, a pasted crawl command
  may start with chaosbringer, npx chaosbringer or pnpm exec chaosbringer. A
  crawl flag (or the URL) given on both sides is refused, exit 2.

  --seed <n>            Every run uses it, so RNG-driven variance is impossible
                        and any flake points at non-determinism outside
                        chaosbringer (server, network, timers). Without it, each
                        run draws its own seed (the verdicts name each run's).
  Each run writes its own copy of what these name (<name>.run<N><ext>, or
  <dir>/run-<N>):
${formatFlagList(FLAKE_PER_RUN_OUTPUTS, "    ")}
  Accepted and not applied (each writes or formats one crawl's report):
${formatFlagList(FLAKE_NOT_APPLIED, "    ")}

VERDICTS:
  Each run passes or fails by the crawl's own exit rules with the same flags
  (--strict, --fail-on-http, --fail-on-network, --fail-on-dead-links,
  --fail-on-warnings, --baseline-strict, and a page that failed, a timeout, a
  crash or an invariant violation without any of them). The verdict is flaky
  when some runs pass and some fail.

EXIT CODES:
  0  nothing flaked (every run passed, or every run failed alike)
  1  the verdict flaked, or a cluster or a page flaked
  2  refused: a bad flag or value, a conflict across --, an input file that is
     missing or does not parse (before Run 1), or nothing answered at the URL
     ("could not reach <url>: is the server running?", after the first run)
`);
}

/** Entry point wired from src/cli.ts when the `flake` subcommand is used. */
export async function runFlakeCli(argv: string[]): Promise<void> {
  const args = parseFlakeArgs(argv);
  // Before Run 1/N: a missing file failed inside the first crawl with exit 1,
  // which chaos-flake.yml reads as "flakes were found". So do the main
  // crawl's other checks that read files or the install.
  const { checkInputFiles } = await import("./input-files.js");
  const { assertPeers } = await import("./peers.js");
  checkInputFiles(args.options);
  const baselineMissing = baselineMissingFromCli(args.crawl);
  assertPeers(crawlCliPeerNeeds(args.crawl));
  const budgets = await readCrawlPerfBudgets(args.crawl as CrawlCliValues, args.options.settle);
  if (budgets?.refusal) throw new UsageError(budgets.refusal.message);
  if (budgets?.warning) console.error(budgets.warning);
  if (budgets) args.options.perfBudgets = budgets.rules;
  if (args.notApplied.length > 0) {
    console.error(
      `chaosbringer flake: not applied to the runs: ${args.notApplied.join(", ")} ` +
        "(each writes or formats one crawl's report; flake writes its analysis, with --output)",
    );
  }

  const { ChaosCrawler } = await import("./crawler.js");
  const baselinePath = args.crawl.baseline;
  const reports: CrawlReport[] = [];
  for (let i = 0; i < args.runs; i++) {
    const options = perRunOptions(args.options, i + 1);
    const crawler = new ChaosCrawler(options);
    if (!args.quiet) {
      const trace = options.traceOut ? `, trace ${options.traceOut}` : "";
      console.log(`Run ${i + 1}/${args.runs} (seed=${crawler.getSeed()}${trace})...`);
    }
    const report = await crawler.start();
    // A site nothing answered for fails the same way every run, which read
    // as a stable cluster and exit 0. Stop at the first.
    const unreachable = unreachableTarget(report, { network: args.options.network });
    if (unreachable) throw new UnreachableTargetError(unreachable);
    // Diffed as the crawl diffs itself, so --baseline-strict judges each run.
    if (applyBaseline(report, baselinePath, baselineMissing) === "refuse") {
      throw new UsageError(`--baseline ${baselinePath}: not found, and --baseline-missing fail refuses a run without it`);
    }
    reports.push(report);
  }
  const analysis = flakeReport(reports, args.exitOptions);
  console.log(formatFlakeReport(analysis));
  if (args.output) {
    writeFileSync(args.output, JSON.stringify(analysis, null, 2));
    if (!args.quiet) console.log(`Analysis saved to: ${args.output}`);
  }
  // Exit 1 if anything flaked — CI uses this to fail a gate. An undecidable
  // analysis fails it too: `--runs` is validated at parse time so this should
  // be unreachable, but the alternative to failing is a green gate that
  // measured nothing, and that is the failure mode worth being paranoid about.
  if (!analysis.decidable) {
    console.error(
      `flake: ${analysis.runs} run(s) cannot decide flakiness — nothing above is a verdict.`,
    );
    process.exit(1);
  }
  if (analysis.verdictFlaky || analysis.flakyClusters.length > 0 || analysis.flakyPages.length > 0) {
    process.exit(1);
  }
}
