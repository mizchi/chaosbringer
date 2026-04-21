/**
 * Top-level convenience that runs a crawl and returns a pre-decided
 * pass/fail + exit code. Most programmatic consumers end up re-deriving
 * these from CrawlReport; this just makes the common case one call.
 */

import { ChaosCrawler } from "./crawler.js";
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
}

export async function chaos(
  options: ChaosRunOptions,
  events: CrawlerEvents = {}
): Promise<ChaosResult> {
  const { strict, ...crawlerOptions } = options;
  const crawler = new ChaosCrawler(crawlerOptions, events);
  const report = await crawler.start();
  const exitCode = getExitCode(report, strict ?? false);
  return { report, passed: exitCode === 0, exitCode };
}
