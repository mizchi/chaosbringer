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
 *   --headless            Run headless (default: true)
 *   --no-headless         Show browser window
 *   --screenshots         Take screenshots
 *   --screenshot-dir      Screenshot directory (default: ./screenshots)
 *   --output <path>       Output report path (default: chaos-report.json)
 *   --exclude <pattern>   Exclude URL patterns (can be repeated)
 *   --compact             Compact output format
 *   --strict              Exit with error on console errors
 *   --quiet               Minimal output
 *   --help                Show this help
 */

import { parseArgs } from "node:util";
import { ChaosCrawler, COMMON_IGNORE_PATTERNS, IGNORE_PRESETS, resolveIgnorePresets } from "./crawler.js";
import { diffReports, loadBaseline } from "./diff.js";
import { printGithubAnnotations } from "./github.js";
import { axe } from "./invariants.js";
import { printReport, saveReport, getExitCode } from "./reporter.js";
import { buildActionHeatmap, formatHeatmap } from "./heatmap.js";
import { buildJunitXml } from "./junit.js";
import { writeFileSync } from "node:fs";
import { parseShardArg } from "./shard.js";
import type { CrawlerOptions, Invariant } from "./types.js";
import { visualRegression } from "./visual.js";

// Subcommand dispatch. Intercept before parseArgs runs so subcommand-specific
// flags (e.g. --match for `minimize`) don't trip the main options map.
//
// Each entry lazy-imports its handler so a `chaosbringer --help` invocation
// doesn't pay the cost of compiling every subcommand. The handler is
// expected to set `process.exitCode` on a non-fatal failure; thrown errors
// are surfaced with the subcommand name and an exit code of 1. Legacy
// handlers (minimize / flake / shard) call `process.exit` directly inside
// themselves and never return, so the final `process.exit` here is only
// reached by the newer handlers that opt into exitCode-based signalling.
const SUBCOMMANDS: Record<string, () => Promise<(argv: string[]) => Promise<void>>> = {
  minimize: () => import("./minimize.js").then((m) => m.runMinimizeCli),
  flake: () => import("./flake.js").then((m) => m.runFlakeCli),
  shard: () => import("./shard.js").then((m) => m.runShardCli),
  recipes: () => import("./recipes/cli.js").then((m) => m.runRecipesCli),
  load: () => import("./recipes/load-cli.js").then((m) => m.runLoadCli),
  diff: () => import("./diff-cli.js").then((m) => m.runDiffCli),
  "cluster-artifacts": () =>
    import("./cluster-artifacts-cli.js").then((m) => m.runClusterArtifactsCli),
  parity: () => import("./parity-cli.js").then((m) => m.runParityCli),
};

const rawSub = process.argv[2];
const subcommand = rawSub && !rawSub.startsWith("-") ? rawSub : null;
if (subcommand && Object.hasOwn(SUBCOMMANDS, subcommand)) {
  try {
    const run = await SUBCOMMANDS[subcommand]();
    await run(process.argv.slice(3));
    process.exit(process.exitCode ?? 0);
  } catch (err) {
    console.error(`${subcommand} failed:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

const { values, positionals } = parseArgs({
  options: {
    url: { type: "string" },
    "max-pages": { type: "string" },
    "max-actions": { type: "string" },
    // Alias to match the underlying CrawlerOptions field name (used by the
    // chaos-pr-gate workflow and surfaced as a synonym in docs).
    "max-actions-per-page": { type: "string" },
    timeout: { type: "string" },
    headless: { type: "boolean", default: true },
    screenshots: { type: "boolean", default: false },
    "screenshot-dir": { type: "string" },
    output: { type: "string" },
    exclude: { type: "string", multiple: true },
    "ignore-error": { type: "string", multiple: true },
    "ignore-analytics": { type: "boolean", default: false },
    "ignore-preset": { type: "string", multiple: true },
    spa: { type: "string", multiple: true },
    "log-file": { type: "string" },
    "log-level": { type: "string" },
    "log-console": { type: "boolean", default: false },
    seed: { type: "string" },
    "har-record": { type: "string" },
    "har-replay": { type: "string" },
    "storage-state": { type: "string" },
    budget: { type: "string", multiple: true },
    axe: { type: "boolean", default: false },
    "axe-tags": { type: "string" },
    "visual-baseline": { type: "string" },
    "visual-threshold": { type: "string" },
    "visual-max-diff-pixels": { type: "string" },
    "visual-max-diff-ratio": { type: "string" },
    "visual-diff-dir": { type: "string" },
    "visual-update": { type: "boolean", default: false },
    "failure-artifacts": { type: "string" },
    "cluster-artifacts": { type: "boolean", default: false },
    "cluster-min-count": { type: "string" },
    "failure-max": { type: "string" },
    "trace-out": { type: "string" },
    "trace-replay": { type: "string" },
    device: { type: "string" },
    network: { type: "string" },
    "seed-from-sitemap": { type: "string" },
    baseline: { type: "string" },
    "baseline-strict": { type: "boolean", default: false },
    "github-annotations": { type: "boolean", default: false },
    shard: { type: "string" },
    heatmap: { type: "boolean", default: false },
    "heatmap-top": { type: "string" },
    "heatmap-out": { type: "string" },
    junit: { type: "string" },
    compact: { type: "boolean", default: false },
    strict: { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

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
  --no-headless         Show the browser window (headless is the default)
  --screenshots         Take screenshots
  --screenshot-dir      Screenshot directory (default: ./screenshots)
  --output <path>       Output report path (default: chaos-report.json)
  --exclude <pattern>   Exclude URL patterns (regex, can be repeated)
  --ignore-error <p>    Ignore error patterns (regex, can be repeated)
  --ignore-analytics    Ignore common analytics script errors (googletagmanager,
                        google-analytics, hotjar, clarity, segment, amplitude,
                        cloudflareinsights, facebook.net, and net::ERR_FAILED)
  --ignore-preset <p>   Apply a named ignore-error preset (can be repeated; comma-separated).
                        Known: analytics, maps, media-embeds, pdf-orb, iframe-sandbox
  --spa <pattern>       Mark URLs as SPA (errors shown separately, can be repeated)
  --log-file <path>     Write execution log to file (JSON format)
  --log-level <level>   Log level: debug, info, warn, error (default: info)
  --log-console         Also output logs to console
  --seed <n>            Seed for deterministic action selection (reproduces a run)
  --har-record <path>   Record network traffic to a HAR file (mutually exclusive with --har-replay)
  --har-replay <path>   Replay network traffic from a HAR file (missing URLs fall through to network)
  --storage-state <p>   Playwright storageState JSON (cookies + localStorage) for authenticated crawls
  --budget <k=ms,...>   Per-metric performance budget, e.g. ttfb=200,fcp=1800,lcp=2500 (repeatable)
  --axe                 Enable axe-core accessibility scan on every page (requires axe-core installed)
  --axe-tags <list>     Comma-separated axe tags (default: wcag2a,wcag2aa,wcag21a,wcag21aa)
  --visual-baseline <dir>  Enable visual regression against baseline PNGs in <dir> (requires pixelmatch + pngjs)
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
  --seed-from-sitemap <url|path>  Prepend URLs listed in a sitemap.xml (or sitemap index)
  --shard <i/N>         Run as shard i of N (filter URLs by hash). Merge with the shard subcommand.
  --heatmap             Print an action-frequency heatmap after the report
  --heatmap-top <n>     Limit the heatmap to the top N targets (default 20)
  --heatmap-out <path>  Also write the heatmap as JSON
  --junit <path>        Write a Surefire-style JUnit XML for CI dashboards
  --baseline <path>     Diff this run against a previous report (warns if missing)
  --baseline-strict     Exit 1 when the diff shows new clusters or newly failing pages
  --github-annotations  Emit GitHub Actions workflow commands for each cluster / dead link
  --compact             Compact output format
  --strict              Exit with error on any console errors
  --quiet               Minimal output
  --help                Show this help

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

// URL from --url or first positional
const baseUrl = values.url || positionals[0];

if (!baseUrl) {
  console.error("Error: --url is required");
  console.error("Run with --help for usage information");
  process.exit(1);
}

// Build ignore patterns
const ignoreErrorPatterns: string[] = [...(values["ignore-error"] || [])];
if (values["ignore-analytics"]) {
  ignoreErrorPatterns.push(...COMMON_IGNORE_PATTERNS);
}
for (const presetSpec of values["ignore-preset"] ?? []) {
  try {
    ignoreErrorPatterns.push(...resolveIgnorePresets(presetSpec));
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    console.error(`Tip: --ignore-preset accepts comma-separated names. Known: ${Object.keys(IGNORE_PRESETS).join(", ")}`);
    process.exit(1);
  }
}

// Validate log level
const validLogLevels = ["debug", "info", "warn", "error"] as const;
const logLevel = values["log-level"] as (typeof validLogLevels)[number] | undefined;
if (logLevel && !validLogLevels.includes(logLevel)) {
  console.error(`Error: Invalid log level "${logLevel}". Valid levels: ${validLogLevels.join(", ")}`);
  process.exit(1);
}

let seed: number | undefined;
if (values.seed !== undefined) {
  const parsed = Number(values.seed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    console.error(`Error: --seed must be a non-negative integer, got "${values.seed}"`);
    process.exit(1);
  }
  seed = parsed;
}

let har: CrawlerOptions["har"];
if (values["har-record"] && values["har-replay"]) {
  console.error("Error: --har-record and --har-replay are mutually exclusive");
  process.exit(1);
}
if (values["har-record"]) har = { path: values["har-record"], mode: "record" };
if (values["har-replay"]) har = { path: values["har-replay"], mode: "replay" };

let performanceBudget: CrawlerOptions["performanceBudget"];
if (values.budget && values.budget.length > 0) {
  performanceBudget = {};
  for (const raw of values.budget) {
    for (const entry of raw.split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) {
        console.error(`Error: --budget expects key=ms pairs (got "${trimmed}")`);
        process.exit(1);
      }
      const key = trimmed.slice(0, eq).trim();
      const ms = Number(trimmed.slice(eq + 1).trim());
      (performanceBudget as Record<string, number>)[key] = ms;
    }
  }
}

let shardIndex: number | undefined;
let shardCount: number | undefined;
if (values.shard) {
  const parsed = parseShardArg(values.shard);
  shardIndex = parsed.shardIndex;
  shardCount = parsed.shardCount;
}

function parseNumberFlag(
  flag: string,
  raw: string | undefined,
  opts: { min?: number; max?: number; integer?: boolean }
): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.error(`Error: ${flag} must be a finite number (got ${JSON.stringify(raw)})`);
    process.exit(1);
  }
  if (opts.integer && !Number.isInteger(n)) {
    console.error(`Error: ${flag} must be an integer (got ${n})`);
    process.exit(1);
  }
  if (opts.min !== undefined && n < opts.min) {
    console.error(`Error: ${flag} must be >= ${opts.min} (got ${n})`);
    process.exit(1);
  }
  if (opts.max !== undefined && n > opts.max) {
    console.error(`Error: ${flag} must be <= ${opts.max} (got ${n})`);
    process.exit(1);
  }
  return n;
}

function buildInvariants(): Invariant[] | undefined {
  const list: Invariant[] = [];
  if (values.axe) {
    list.push(
      axe({
        tags: values["axe-tags"]
          ? values["axe-tags"]
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined,
      })
    );
  }
  if (values["visual-baseline"]) {
    list.push(
      visualRegression({
        baselineDir: values["visual-baseline"],
        threshold: parseNumberFlag("--visual-threshold", values["visual-threshold"], {
          min: 0,
          max: 1,
        }),
        maxDiffPixels: parseNumberFlag(
          "--visual-max-diff-pixels",
          values["visual-max-diff-pixels"],
          { min: 0, integer: true }
        ),
        maxDiffRatio: parseNumberFlag(
          "--visual-max-diff-ratio",
          values["visual-max-diff-ratio"],
          { min: 0, max: 1 }
        ),
        diffDir: values["visual-diff-dir"],
        updateBaseline: values["visual-update"],
      })
    );
  }
  return list.length > 0 ? list : undefined;
}

const options: CrawlerOptions = {
  baseUrl,
  maxPages: values["max-pages"] ? parseInt(values["max-pages"], 10) : undefined,
  maxActionsPerPage: (() => {
    const raw = values["max-actions"] ?? values["max-actions-per-page"];
    return raw ? parseInt(raw, 10) : undefined;
  })(),
  timeout: values.timeout ? parseInt(values.timeout, 10) : undefined,
  headless: values.headless,
  screenshots: values.screenshots,
  screenshotDir: values["screenshot-dir"],
  excludePatterns: values.exclude,
  ignoreErrorPatterns: ignoreErrorPatterns.length > 0 ? ignoreErrorPatterns : undefined,
  spaPatterns: values.spa,
  logFile: values["log-file"],
  logLevel: logLevel,
  logToConsole: values["log-console"],
  seed,
  har,
  storageState: values["storage-state"],
  performanceBudget,
  traceOut: values["trace-out"],
  traceReplay: values["trace-replay"],
  device: values.device,
  network: values.network as CrawlerOptions["network"],
  seedFromSitemap: values["seed-from-sitemap"],
  shardIndex,
  shardCount,
  failureArtifacts: values["failure-artifacts"]
    ? {
        dir: values["failure-artifacts"],
        maxArtifacts: parseNumberFlag("--failure-max", values["failure-max"], {
          min: 0,
          integer: true,
        }),
      }
    : undefined,
  invariants: buildInvariants(),
};

const outputPath = values.output || "chaos-report.json";
const isQuiet = values.quiet;
const isCompact = values.compact;
const isStrict = values.strict;
const baselinePath = values.baseline;
const isBaselineStrict = values["baseline-strict"];
const emitGithub = values["github-annotations"];

async function main() {
  if (!isQuiet) {
    console.log(`Starting chaos crawl: ${baseUrl}`);
    console.log(`Max pages: ${options.maxPages || 50}`);
    console.log("");
  }

  const crawler = new ChaosCrawler(options, {
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
        process.stdout.write(`\rProgress: ${visited}/${total} pages`);
      }
    },
  });

  try {
    const report = await crawler.start();

    if (isCompact && !isQuiet) {
      console.log(""); // New line after progress
    }

    if (baselinePath) {
      const prev = loadBaseline(baselinePath);
      if (prev) {
        report.diff = diffReports(prev, report, { baselinePath });
      } else if (!isQuiet) {
        // First CI run won't have a baseline yet. Warn, but keep going — the
        // report we write here becomes the baseline for next time.
        console.warn(`Baseline not found at ${baselinePath} — skipping diff.`);
      }
    }

    // Print report first, then save + announce the file. This way the main
    // textual output is one contiguous block and the "saved to" line is the
    // last thing on screen — friendlier for scrolling CI logs.
    const exitOptions = { strict: isStrict, baselineStrict: isBaselineStrict };
    printReport(report, isCompact, exitOptions);
    if (emitGithub) {
      printGithubAnnotations(report, { strict: isStrict });
    }

    const wantsHeatmap = values.heatmap || Boolean(values["heatmap-out"]);
    if (wantsHeatmap) {
      const entries = buildActionHeatmap(report.actions);
      if (values.heatmap && !isQuiet) {
        const top =
          parseNumberFlag("--heatmap-top", values["heatmap-top"], {
            min: 0,
            integer: true,
          }) ?? 20;
        console.log("");
        console.log(formatHeatmap(entries, top));
      }
      const heatmapOut = values["heatmap-out"];
      if (heatmapOut) {
        writeFileSync(heatmapOut, JSON.stringify(entries, null, 2));
        if (!isQuiet) console.log(`\nHeatmap saved to: ${heatmapOut}`);
      }
    }

    if (values["cluster-artifacts"]) {
      const failureDir = values["failure-artifacts"];
      if (!failureDir) {
        console.error(
          "--cluster-artifacts requires --failure-artifacts <dir> (it copies from the per-page bundles)",
        );
        process.exit(1);
      }
      const { writeClusterArtifacts } = await import("./cluster-artifacts.js");
      const minCount = values["cluster-min-count"]
        ? parseInt(values["cluster-min-count"], 10)
        : undefined;
      const results = writeClusterArtifacts(report, {
        bundleDir: failureDir,
        minCount,
      });
      if (!isQuiet) {
        console.log(`\nWrote ${results.length} cluster bundle(s) to ${failureDir}/clusters/`);
      }
    }

    saveReport(report, outputPath);
    if (!isQuiet) {
      console.log(`\nReport saved to: ${outputPath}`);
    }

    if (values.junit) {
      writeFileSync(values.junit, buildJunitXml(report));
      if (!isQuiet) console.log(`JUnit XML saved to: ${values.junit}`);
    }

    const exitCode = getExitCode(report, exitOptions);
    process.exit(exitCode);
  } catch (err) {
    console.error("Crawl failed:", err);
    process.exit(1);
  }
}

main();
