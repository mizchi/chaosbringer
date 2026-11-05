#!/usr/bin/env node
/**
 * Chaosbringer CLI
 *
 * Usage:
 *   pnpm tsx src/cli.ts [options]
 *   chaosbringer [options]  (when installed globally)
 *
 * Options:
 *   --url <url>           Base URL to crawl (required)
 *   --max-pages <n>       Max pages to visit (default: 50)
 *   --max-actions <n>     Max random actions per page (default: 5)
 *   --timeout <ms>        Page load timeout (default: 30000)
 *   --settle <mode>       networkidle (default), adaptive, or an adaptive quiet window in ms
 *   --headless            Run headless (default: true)
 *   --no-headless         Show browser window
 *   --cdp <port|url>      Connect to an existing Chromium tab
 *   --cdp-target <id>     Select a CDP target
 *   --screenshots         Take screenshots
 *   --screenshot-dir      Screenshot directory (default: ./screenshots)
 *   --output <path>       Output report path (default: chaos-report.json)
 *   --exclude <pattern>   Exclude URL patterns (can be repeated)
 *   --compact             Compact output format
 *   --strict              Fail on console errors, JS exceptions and unhandled rejections
 *   --quiet               Print only the verdict, why a run failed, and the paths written
 *   --help, -h            Show this help
 *   --version, -V         Print the version
 */

import { attachHint } from "./browser-bind.js";
import { ChaosCrawler } from "./crawler.js";
import {
  baselineMissingFromCli,
  crawlCliExtras,
  crawlCliPeerNeeds,
  crawlerOptionsFromCli,
  exitOptionsFromCli,
  crawlUrlFromArgs,
  parseCrawlArgs,
  readCrawlPerfBudgets,
} from "./cli-crawl-options.js";
import {
  formatSubcommandList,
  isUsageError,
  packageVersion,
  progressText,
  SUBCOMMANDS,
  type UsageError,
  usageErrorMessage,
} from "./cli-usage.js";
import { printGithubAnnotations } from "./github.js";
import { type ExitCodeOptions, formatQuietReport, printReport, saveReport, getExitCode } from "./reporter.js";
import { applyBaseline } from "./run-warnings.js";
import { buildActionHeatmap, formatHeatmap } from "./heatmap.js";
import { buildJunitXml } from "./junit.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CrawlerOptions } from "./types.js";
import { isUnreachableTargetError, unreachableTarget, unreachableTargetMessage } from "./unreachable-target.js";
import { checkInputFiles } from "./input-files.js";
import { assertPeers, isMissingPeerError } from "./peers.js";
import { validateOptions } from "./validate.js";

// Subcommand dispatch (the table is SUBCOMMANDS in cli-usage.ts). Intercept
// before parseArgs runs so subcommand-specific flags (e.g. --match for
// `minimize`) don't trip the main options map.
//
// The handler is expected to set `process.exitCode` on a non-fatal failure;
// thrown errors are surfaced with the subcommand name and an exit code of 1.
// A refused invocation — what `parseArgs` throws for an unknown flag, a
// `UsageError` for a missing operand, a bad value or an input file that is
// not there, or a `MissingPeerError` — is reported like the main command's
// own (`exitWithUsageError`): one line, exit 2. It used to be
// `<sub> failed: Unknown option …` and exit 1, which a CI step reads as "the
// run found something". `flake` still calls `process.exit(1)` itself on a
// flaky run, and `minimize` / `flake` `process.exit(0)` on --help.
const rawSub = process.argv[2];
const subcommand = rawSub && !rawSub.startsWith("-") ? rawSub : null;
if (subcommand && Object.hasOwn(SUBCOMMANDS, subcommand)) {
  try {
    const run = await SUBCOMMANDS[subcommand].load();
    await run(process.argv.slice(3));
    process.exit(process.exitCode ?? 0);
  } catch (err) {
    if (isUsageError(err) || isMissingPeerError(err)) {
      console.error(usageErrorMessage(err, `chaosbringer ${(err as UsageError).command ?? subcommand}`));
      process.exit(2);
    }
    // `flake` and `scan` on a site nothing answers for: refused like a usage
    // error, one line and exit 2, but not one the --help would fix.
    if (isUnreachableTargetError(err)) {
      console.error(`chaosbringer ${subcommand}: ${err.message}`);
      process.exit(2);
    }
    console.error(`${subcommand} failed:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

/**
 * Report a refused invocation in one line and exit 2, the code the CLI
 * already used for a `--perf-budgets` file it refuses: nothing ran. An
 * unknown flag or a malformed number used to escape as a Node stack trace
 * with exit 1, the code of a crawl that found something.
 */
function exitWithUsageError(err: unknown): never {
  console.error(usageErrorMessage(err));
  process.exit(2);
}

let parsed: ReturnType<typeof parseCrawlArgs>;
try {
  parsed = parseCrawlArgs();
} catch (err) {
  exitWithUsageError(err);
}
const { values, positionals } = parsed;

if (values.version) {
  console.log(packageVersion());
  process.exit(0);
}

if (values.help) {
  console.log(`
Chaosbringer - Playwright-based chaos testing tool

USAGE:
  chaosbringer --url <url> [options]

OPTIONS:
  --url <url>           Base URL to crawl (required)
  --max-pages <n>       Max pages to visit (default: 50)
  --max-actions <n>     Max random actions per page (default: 5)
                        (alias: --max-actions-per-page)
  --timeout <ms>        Page load timeout (default: 30000)
  --settle <mode>       How each load and action settles: networkidle (default), adaptive
                        (no requests / long tasks for 100 ms + 2 frames, capped at the old
                        timeouts), or <ms> — adaptive with that quiet window
  --no-headless         Show the browser window (headless is the default)
  --cdp <port|url>      Crawl in an existing Chromium tab over CDP
  --cdp-target <id>     Select a tab by its CDP target id
  --terminal-browser    Find the visible terminal-browser tab for --url
  --screenshots         Take screenshots
  --screenshot-dir      Screenshot directory (default: ./screenshots)
  --output <path>       Output report path (default: chaos-report.json)
  --exclude <pattern>   Exclude URL patterns (regex, can be repeated)
  --ignore-error <p>    Ignore error patterns (regex, can be repeated)
  --ignore-analytics    Ignore common analytics script errors (googletagmanager,
                        google-analytics, doubleclick, googleadservices, hotjar,
                        clarity, segment, amplitude, mixpanel, cloudflareinsights,
                        facebook.net, and net::ERR_FAILED)
  --ignore-preset <p>   Apply a named ignore-error preset (can be repeated; comma-separated).
                        Known: analytics, maps, media-embeds, pdf-orb, iframe-sandbox
  --ignore-http <pattern>  Request URLs (regex) whose 4xx / 5xx answer is not an HTTP error:
                        not counted, and its "Failed to load resource" line dropped (can be repeated)
  --spa <pattern>       Mark URLs as SPA (errors shown separately, can be repeated)
  --log-file <path>     Write execution log to file (JSON format)
  --log-level <level>   Log level: debug, info, warn, error (default: info; warn for
                        --log-console without --log-file)
  --log-console         Also output logs to the console; without --log-file, to stderr
  --seed <n>            Seed for deterministic action selection (reproduces a run)
  --har-record <path>   Record network traffic to a HAR file (mutually exclusive with --har-replay)
  --har-replay <path>   Replay network traffic from a HAR file (missing URLs fall through to network)
  --storage-state <p>   Playwright storageState JSON (cookies + localStorage) for authenticated crawls
  --budget <k=ms,...>   Per-metric performance budget, e.g. ttfb=200,fcp=1800,lcp=2500 (repeatable;
                        keys: ttfb, fcp, lcp, tbt, domContentLoaded, load; each ms > 0)
  --aria-targets        Also find targets through the accessibility snapshot (clickable divs the
                        CSS scrape misses), and describe targets from the tree to drivers
  --bind                Serve the crawl's browser to other Playwright clients while it runs:
                        npx playwright cli attach <title> / npx playwright mcp --endpoint <ep>
  --bind-title <title>  Name to attach by (default chaosbringer)
  --axe                 Enable axe-core accessibility scan on every page (requires axe-core
                        installed: without it the run is refused, exit 2)
  --axe-tags <list>     Comma-separated axe tags (default: wcag2a,wcag2aa,wcag21a,wcag21aa)
  --invariants <list>   Run these checks on every page (comma-separated, repeatable): data-safety
                        (xss-marker, injected-markup, prototype-pollution and rendered-garbage;
                        not not-blank), any of those or not-blank by name, axe (= --axe). Each
                        runs with its defaults: set options through the library
                        (invariants.dataSafety({ ... })). A violation fails the run
  --data-safety         Shorthand for --invariants data-safety
  --visual-baseline <dir>  Enable visual regression against baseline PNGs in <dir> (requires
                        pixelmatch + pngjs: without them the run is refused, exit 2)
  --visual-threshold <n>   pixelmatch color threshold 0..1 (default 0.1)
  --visual-max-diff-pixels <n>  Absolute pixel budget; fail when exceeded (default 0)
  --visual-max-diff-ratio <n>   Ratio pixel budget (0..1); evaluated alongside max-diff-pixels
  --visual-diff-dir <dir>  Write diff PNGs here on failure
  --visual-update       Overwrite baselines with current screenshots (for intentional UI updates)
  --failure-artifacts <dir>  Write a bundle (screenshot + html + errors + trace + repro.sh) per failing page
  --failure-max <n>     Cap the number of failure bundles per run (default: unlimited)
  --cluster-artifacts   After the crawl, emit one representative bundle per error cluster in <failure-artifacts>/clusters/
  --cluster-min-count <n>  Skip clusters with count below n when --cluster-artifacts is set
  --trace-out <path>    Write a JSONL trace of visits + actions for replay / minimize
  --trace-replay <path> Replay a previously recorded trace instead of random actions
  --device <name>       Emulate a Playwright device descriptor (e.g. "iPhone 14", "Pixel 7")
  --network <profile>   Throttle with a CDP preset: slow-3g, fast-3g, offline
  --no-http-cache       Disable the browser HTTP cache on every page (cold-cache measurement)
  --seed-from-sitemap <url|path>  Prepend URLs listed in a sitemap.xml (or sitemap index)
  --shard <i/N>         Run as shard i of N (filter URLs by hash). Merge with the shard subcommand.
  --heatmap             Print an action-frequency heatmap after the report
  --heatmap-top <n>     Limit the heatmap to the top N targets (default 20)
  --heatmap-out <path>  Also write the heatmap as JSON
  --junit <path>        Write a Surefire-style JUnit XML for CI dashboards
  --perf                Measure every page load and action as a span (lightbringer, light level)
  --perf-trace          Also record a Chrome trace per page (large; implies --perf)
  --perf-mem            Force GC at span boundaries for retained-only memory deltas (slow; implies --perf)
  --perf-cov            Record JS/CSS byte coverage per page (implies --perf)
  --perf-out <dir>      Write each page's full perf report (+ trace/coverage) to <dir> (implies --perf)
  --perf-budgets <file> Per-span budgets by perfKey glob: a perfBudgets JSON array or a
                        \`perf emit-budgets\` file; a breach is a perf-budget.<metric> violation (implies --perf).
                        An emit-budgets file measured under another --settle mode is refused (exit 2)
  --allow-settle-mismatch  Enforce such --perf-budgets anyway, with a warning
  --baseline <path>     Diff this run against a previous report (a missing one is a warning)
  --baseline-strict     Exit 1 when the diff shows new clusters or newly failing pages
  --baseline-missing <warn|fail>  A missing --baseline file: warn (default; the first run,
                        whose report becomes the baseline) or fail (refused, exit 2)
  --github-annotations  Emit GitHub Actions workflow commands for each cluster / dead link /
                        warning: ::error for what fails the run under its rules (and every
                        JS exception), ::warning otherwise
  --compact             Compact output format
  --strict              Fail on console errors, JS exceptions and unhandled rejections
                        (not on the browser's echo of a fault the run injected)
  --fail-on-http <5xx|4xx>  Fail on a subresource or API response of 500 and up (5xx) or 400
                        and up (4xx); the page's own document is a dead link instead
  --fail-on-network     Fail on a request that failed at the transport level (net::ERR_…;
                        not a 4xx / 5xx file's ERR_ABORTED, which is an HTTP error)
  --fail-on-dead-links  Fail on a crawled link that answered 404 / 5xx
  --fail-on-warnings    Fail on a run with warnings: what made it test less than it was set
                        up to (a --seed-from-sitemap that could not be read or listed no
                        URL, a --network profile or --no-http-cache that did not apply, a
                        missing --baseline)
  --quiet               Print only the verdict, why a run failed, and the paths written
  --help, -h            Show this help
  --version, -V         Print the version

EXIT CODES:
  0  nothing failed
  1  the run found something: a page that failed or timed out, an invariant violation,
     a renderer crash, --strict errors, --baseline-strict regressions, what a
     --fail-on-http / --fail-on-network / --fail-on-dead-links / --fail-on-warnings rule
     fails on
  2  the run was refused before a browser started: an unknown flag or --invariants name, a
     malformed value, an input file (--storage-state, --har-replay, --trace-replay,
     --perf-budgets, a --seed-from-sitemap path, a --baseline under --baseline-missing fail)
     that is missing or does not parse, a peer
     --axe (or --invariants axe) / --visual-baseline needs that is not installed; or nothing
     answered at --url

SUBCOMMANDS (chaosbringer <subcommand> --help for its options):
${formatSubcommandList()}

PERF SUBCOMMANDS (read crawl reports written with --perf):
  chaosbringer perf emit-budgets <report.json...> [--headroom 1.25] [--floor <metric>=<n>]... [--out <file>]
  chaosbringer perf gate <report.json...> --budgets <file> [--json]
  chaosbringer perf regress <baselineDir|report.json...> --current <report.json...> [--threshold 0.15]
  chaosbringer perf drilldown <report.json> <perfKey> [--top N]
  (chaosbringer perf --help for details)

SCAN (bugs + slow spots of an unknown site, one command):
  chaosbringer scan --url <url> [--max-pages 20] [--out chaosbringer-scan] [--no-chaos]
  (chaosbringer scan --help for details)

DRIVE (operate the browser towards a goal, with the checks running):
  chaosbringer drive --url <url> --goal "<what to do>" [--until-text <text>] [--video run.webm]
  (chaosbringer drive --help for details)

EXAMPLES:
  # Basic crawl
  chaosbringer --url http://localhost:3000

  # With screenshots and limited pages
  chaosbringer --url https://docs.example.com --max-pages 20 --screenshots

  # CI mode with strict checking (ignore analytics errors)
  chaosbringer --url http://localhost:3000 --strict --compact --ignore-analytics

  # With detailed logging to file
  chaosbringer --url http://localhost:3000 --log-file crawl.log --log-level debug

  # Reproduce a failing run by passing its seed
  chaosbringer --url http://localhost:3000 --seed 1234567

  # Exclude patterns and ignore specific errors
  chaosbringer --url http://localhost:3000 --exclude "/api/" --ignore-error "third-party"
`);
  process.exit(0);
}

let baseUrl: string;
try {
  baseUrl = crawlUrlFromArgs(values, positionals);
} catch (err) {
  exitWithUsageError(err);
}

let options: CrawlerOptions;
let heatmapTop: number;
let clusterMinCount: number | undefined;
let exitOptions: ExitCodeOptions;
try {
  options = crawlerOptionsFromCli(values, baseUrl);
  ({ heatmapTop, clusterMinCount } = crawlCliExtras(values));
  exitOptions = exitOptionsFromCli(values);
} catch (err) {
  exitWithUsageError(err);
}

try {
  const budgets = await readCrawlPerfBudgets(values, options.settle);
  if (budgets) {
    options.perfBudgets = budgets.rules;
    if (budgets.warning) console.error(budgets.warning);
    if (budgets.refusal) {
      console.error(`chaosbringer: ${budgets.refusal.message}`);
      process.exit(budgets.refusal.exitCode);
    }
  }
} catch (err) {
  exitWithUsageError(err);
}

// The crawler validates again; this is so a refused option is a usage error
// (`--max-pages 0`, `--cdp-target` without `--cdp`), not a stack trace from
// inside main() after "Starting chaos crawl" was already printed. So are the
// files the crawl reads (a missing `--storage-state` failed once the browser
// was up, with exit 1) and the packages `--axe` / `--visual-baseline` need.
let baselineMissing: ReturnType<typeof baselineMissingFromCli>;
try {
  validateOptions(options);
  checkInputFiles(options);
  baselineMissing = baselineMissingFromCli(values);
  assertPeers(crawlCliPeerNeeds(values));
} catch (err) {
  exitWithUsageError(err);
}

const outputPath = values.output || "chaos-report.json";
const isQuiet = values.quiet;
const isCompact = values.compact;
const isTTY = process.stdout.isTTY === true;
const baselinePath = values.baseline;
const emitGithub = values["github-annotations"];

async function main() {
  if (!isQuiet) {
    console.log(`Starting chaos crawl: ${baseUrl}`);
    console.log(`Max pages: ${options.maxPages || 50}`);
    console.log("");
  }

  let failureBundles = 0;
  const crawler = new ChaosCrawler(options, {
    onBind: (b) => console.log(attachHint(b)),
    onFailureBundle: () => {
      failureBundles++;
    },
    onPageStart: (url) => {
      if (!isQuiet && !isCompact) {
        process.stdout.write(`Crawling: ${url}...`);
      }
    },
    onPageComplete: (result) => {
      if (!isQuiet && !isCompact) {
        // OK = navigation succeeded. Page-level errors are shown separately
        // so a user reading the line above can tell an OK-but-noisy page
        // apart from one that failed to load.
        const baseLabel = result.status === "success" ? "OK" : result.status.toUpperCase();
        const label = result.hasErrors ? `${baseLabel} (${result.errors.length} errors)` : baseLabel;
        console.log(` ${label} [${result.loadTime}ms]`);
      }
    },
    onProgress: (visited, total) => {
      if (!isQuiet && isCompact) {
        process.stdout.write(progressText(visited, total, isTTY));
      }
    },
  });

  try {
    const report = await crawler.start();

    if (isCompact && !isQuiet && isTTY) {
      console.log(""); // New line after progress
    }

    // Nothing answered at the start URL: no run was made, so no report, no
    // verdict, no baseline, perf or JUnit file a later step could take for
    // one (a perf median over a crawl of nothing, a --baseline of it). What
    // the crawl wrote as it went, its failure bundles and --trace-out, may
    // already be on disk.
    const unreachable = unreachableTarget(report, { network: options.network });
    if (unreachable) {
      console.error(`chaosbringer: ${unreachableTargetMessage(unreachable)}`);
      process.exit(2);
    }

    // A missing baseline: the first CI run won't have one yet. A warning, and
    // keep going (the report we write here becomes the baseline for next
    // time); a `report.warnings` entry, so --quiet shows it too (the stderr
    // line it was left out there) and --fail-on-warnings can refuse it.
    if (applyBaseline(report, baselinePath, baselineMissing) === "refuse") {
      // Checked before the browser started; gone since.
      console.error(`chaosbringer: --baseline ${baselinePath}: not found, and --baseline-missing fail refuses a run without it`);
      process.exit(2);
    }

    // Print report first, then save + announce the file. This way the main
    // textual output is one contiguous block and the "saved to" line is the
    // last thing on screen — friendlier for scrolling CI logs.
    // --quiet is the verdict, why it failed, and where the files went: what
    // a script or a CI step shows, and the paths it reads next. It used to
    // print the whole report, so the flag only dropped the per-page lines.
    if (isQuiet) console.log(formatQuietReport(report, exitOptions));
    else printReport(report, isCompact, exitOptions);
    // A path line, set off from the report by a blank line unless --quiet.
    const announce = (line: string) => console.log(isQuiet ? line : `\n${line}`);
    if (emitGithub) {
      // At the level the exit rules give each one: `error` only for what fails the run.
      printGithubAnnotations(report, exitOptions);
    }

    const wantsHeatmap = values.heatmap || Boolean(values["heatmap-out"]);
    if (wantsHeatmap) {
      const entries = buildActionHeatmap(report.actions);
      if (values.heatmap && !isQuiet) {
        console.log("");
        console.log(formatHeatmap(entries, heatmapTop));
      }
      const heatmapOut = values["heatmap-out"];
      if (heatmapOut) {
        mkdirSync(dirname(heatmapOut), { recursive: true });
        writeFileSync(heatmapOut, JSON.stringify(entries, null, 2));
        announce(`Heatmap saved to: ${heatmapOut}`);
      }
    }

    // What reproduces a failure was written by the crawl, and no line said
    // where: under --quiet, whose help promises the paths written, the
    // verdict and `Report saved to:` were all a CI log showed. Only when
    // there is one: a passing run named a directory it never made.
    const failureDir = values["failure-artifacts"];
    // `<dir>/`, also for a --failure-artifacts that ended in `/` (`<dir>//`).
    const asDir = (path: string) => `${path.replace(/\/+$/, "")}/`;
    if (failureDir && failureBundles > 0) announce(`Wrote ${failureBundles} failure bundle(s) to ${asDir(failureDir)}`);
    if (values["trace-out"]) announce(`Trace saved to: ${values["trace-out"]}`);
    if (values["log-file"]) announce(`Log saved to: ${values["log-file"]}`);

    // Checked with the other flags: --cluster-artifacts has --failure-artifacts.
    if (values["cluster-artifacts"] && failureDir) {
      const { writeClusterArtifacts } = await import("./cluster-artifacts.js");
      const results = writeClusterArtifacts(report, {
        bundleDir: failureDir,
        minCount: clusterMinCount,
      });
      announce(`Wrote ${results.length} cluster bundle(s) to ${asDir(failureDir)}clusters/`);
    }

    saveReport(report, outputPath);
    announce(`Report saved to: ${outputPath}`);

    if (values.junit) {
      mkdirSync(dirname(values.junit), { recursive: true });
      writeFileSync(values.junit, buildJunitXml(report));
      console.log(`JUnit XML saved to: ${values.junit}`);
    }

    const exitCode = getExitCode(report, exitOptions);
    process.exit(exitCode);
  } catch (err) {
    console.error("Crawl failed:", err);
    process.exit(1);
  }
}

main();
