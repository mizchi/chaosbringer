/**
 * Top-level convenience that runs a crawl and returns a pre-decided
 * pass/fail + exit code. Most programmatic consumers end up re-deriving
 * these from CrawlReport; this just makes the common case one call.
 */

import { chromium, type Page } from "playwright";
import { ChaosCrawler } from "./crawler.js";
import { diffReports, hasRegressions, loadBaseline } from "./diff.js";
import { getExitCode } from "./reporter.js";
import type { CrawlerEvents, CrawlerOptions, CrawlReport } from "./types.js";

export interface ChaosResult {
  report: CrawlReport;
  passed: boolean;
  exitCode: number;
}

/**
 * Context handed to the `setup` hook. `page` is a one-shot Playwright page
 * that lives only for the duration of the hook; it is closed before the
 * crawler starts. Use `page.request` for REST seeding, or drive UI flows
 * (e.g. login, then save the resulting `storageState` to disk and feed the
 * path to `options.storageState`) when you need browser context to carry
 * into the crawl.
 */
export interface ChaosSetupContext {
  page: Page;
  baseUrl: string;
}

export type ChaosSetupHook = (ctx: ChaosSetupContext) => Promise<void>;

export interface ChaosRunOptions extends CrawlerOptions {
  /** Treat console errors / JS exceptions as failures when computing exitCode. */
  strict?: boolean;
  /**
   * Path to a previous report to diff against. A missing file is treated as
   * "first run" (no diff is produced, no warning raised in the library —
   * the CLI handles the warning). When supplied and readable, `report.diff`
   * is populated.
   */
  baseline?: string;
  /** When true, new regressions vs the baseline force exitCode=1. */
  baselineStrict?: boolean;
  /**
   * Pre-run hook that fires before any chaos action or fault rolls. Receives
   * a Playwright page in a disposable browser context. Typical use is REST
   * seeding via `page.request.post(...)` so the crawler has navigable state
   * to discover. The disposable context does NOT carry into the crawl —
   * propagate shared state through the server (REST) or by saving
   * `storageState` to a path that the main crawler reads.
   */
  setup?: ChaosSetupHook;
}

async function runSetup(hook: ChaosSetupHook, baseUrl: string): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await hook({ page, baseUrl });
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

export async function chaos(
  options: ChaosRunOptions,
  events: CrawlerEvents = {}
): Promise<ChaosResult> {
  const { strict, baseline, baselineStrict, setup, ...crawlerOptions } = options;

  // Construct the crawler before invoking the setup hook so that
  // CrawlerOptions validation (bad maxPages, malformed fault regex,
  // invalid shard settings, …) runs first. Otherwise a user-visible
  // side effect — typically a backend seed POST — fires for runs that
  // would then fail validation, mutating state that should never have
  // been touched. ChaosCrawler's constructor is side-effect-free; the
  // browser doesn't start until .start(), so the re-ordering is safe.
  const crawler = new ChaosCrawler(crawlerOptions, events);

  if (setup) {
    await runSetup(setup, options.baseUrl);
  }

  const report = await crawler.start();

  if (baseline) {
    const prev = loadBaseline(baseline);
    if (prev) {
      report.diff = diffReports(prev, report, { baselinePath: baseline });
    }
  }

  const exitCode = getExitCode(report, { strict, baselineStrict });
  return { report, passed: exitCode === 0, exitCode };
}

export { diffReports, loadBaseline, hasRegressions };
