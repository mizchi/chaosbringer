/**
 * Top-level convenience that runs a crawl and returns a pre-decided
 * pass/fail + exit code. Most programmatic consumers end up re-deriving
 * these from CrawlReport; this just makes the common case one call.
 */

import { ChaosCrawler } from "./crawler.js";
import { diffReports, hasRegressions, loadBaseline } from "./diff.js";
import { getExitCode } from "./reporter.js";
import type { CrawlerEvents, CrawlerOptions, CrawlReport } from "./types.js";

export interface ChaosResult {
  report: CrawlReport;
  passed: boolean;
  exitCode: number;
}

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
}

export async function chaos(
  options: ChaosRunOptions,
  events: CrawlerEvents = {}
): Promise<ChaosResult> {
  const { strict, baseline, baselineStrict, ...crawlerOptions } = options;
  const crawler = new ChaosCrawler(crawlerOptions, events);
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
