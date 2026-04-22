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
import { ChaosCrawler, COMMON_IGNORE_PATTERNS } from "./crawler.js";
import { diffReports, loadBaseline } from "./diff.js";
import { printReport, saveReport, getExitCode } from "./reporter.js";
import type { CrawlerOptions } from "./types.js";

const { values, positionals } = parseArgs({
  options: {
    url: { type: "string" },
    "max-pages": { type: "string" },
    "max-actions": { type: "string" },
    timeout: { type: "string" },
    headless: { type: "boolean", default: true },
    screenshots: { type: "boolean", default: false },
    "screenshot-dir": { type: "string" },
    output: { type: "string" },
    exclude: { type: "string", multiple: true },
    "ignore-error": { type: "string", multiple: true },
    "ignore-analytics": { type: "boolean", default: false },
    spa: { type: "string", multiple: true },
    "log-file": { type: "string" },
    "log-level": { type: "string" },
    "log-console": { type: "boolean", default: false },
    seed: { type: "string" },
    "har-record": { type: "string" },
    "har-replay": { type: "string" },
    "storage-state": { type: "string" },
    baseline: { type: "string" },
    "baseline-strict": { type: "boolean", default: false },
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
  --spa <pattern>       Mark URLs as SPA (errors shown separately, can be repeated)
  --log-file <path>     Write execution log to file (JSON format)
  --log-level <level>   Log level: debug, info, warn, error (default: info)
  --log-console         Also output logs to console
  --seed <n>            Seed for deterministic action selection (reproduces a run)
  --har-record <path>   Record network traffic to a HAR file (mutually exclusive with --har-replay)
  --har-replay <path>   Replay network traffic from a HAR file (missing URLs fall through to network)
  --storage-state <p>   Playwright storageState JSON (cookies + localStorage) for authenticated crawls
  --baseline <path>     Diff this run against a previous report (warns if missing)
  --baseline-strict     Exit 1 when the diff shows new clusters or newly failing pages
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

const options: CrawlerOptions = {
  baseUrl,
  maxPages: values["max-pages"] ? parseInt(values["max-pages"], 10) : undefined,
  maxActionsPerPage: values["max-actions"] ? parseInt(values["max-actions"], 10) : undefined,
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
};

const outputPath = values.output || "chaos-report.json";
const isQuiet = values.quiet;
const isCompact = values.compact;
const isStrict = values.strict;
const baselinePath = values.baseline;
const isBaselineStrict = values["baseline-strict"];

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
    saveReport(report, outputPath);
    if (!isQuiet) {
      console.log(`\nReport saved to: ${outputPath}`);
    }

    const exitCode = getExitCode(report, exitOptions);
    process.exit(exitCode);
  } catch (err) {
    console.error("Crawl failed:", err);
    process.exit(1);
  }
}

main();
