/**
 * Top-level convenience that runs a crawl and returns a pre-decided
 * pass/fail + exit code. Most programmatic consumers end up re-deriving
 * these from CrawlReport; this just makes the common case one call.
 */

import { chromium, type Page } from "playwright";
import { ChaosCrawler } from "./crawler.js";
import { diffReports, hasRegressions, loadBaseline } from "./diff.js";
import { getExitCode, HTTP_FAIL_LEVELS, type HttpFailLevel } from "./reporter.js";
import type {
  CrawlerEvents,
  CrawlerOptions,
  CrawlReport,
  ChaosRemoteServer,
} from "./types.js";
import { newIsolatedPage } from "./browser-session.js";

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
   * Fail on a subresource or API response of 500 and up (`"5xx"`) or 400
   * and up (`"4xx"`): the CLI's `--fail-on-http`. The browser's echo of a
   * `faults.status` rule's answer does not count.
   */
  failOnHttp?: HttpFailLevel;
  /** Fail on a request that failed at the transport level: the CLI's `--fail-on-network`. */
  failOnNetwork?: boolean;
  /** Fail on a crawled link that answered 404 / 5xx: the CLI's `--fail-on-dead-links`. */
  failOnDeadLinks?: boolean;
  /**
   * Pre-run hook that fires before any chaos action or fault rolls. Receives
   * a Playwright page in a disposable browser context. Typical use is REST
   * seeding via `page.request.post(...)` so the crawler has navigable state
   * to discover. The disposable context does NOT carry into the crawl —
   * propagate shared state through the server (REST) or by saving
   * `storageState` to a path that the main crawler reads.
   */
  setup?: ChaosSetupHook;
  /**
   * Surface server-side fault events into `report.serverFaults`. Phase 1:
   * `{ mode: "remote" }` reads `x-chaos-fault-*` response headers emitted
   * by `@mizchi/server-faults` running in the server process.
   */
  server?: ChaosRemoteServer;
}

async function runSetup(hook: ChaosSetupHook, baseUrl: string): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const { page, close } = await newIsolatedPage(browser);
    try {
      await hook({ page, baseUrl });
    } finally {
      await close();
    }
  } finally {
    await browser.close();
  }
}

export async function chaos(
  options: ChaosRunOptions,
  events: CrawlerEvents = {}
): Promise<ChaosResult> {
  const { strict, baseline, baselineStrict, failOnHttp, failOnNetwork, failOnDeadLinks, setup, server, ...crawlerOptions } =
    options;
  // Before anything runs, like the crawler's own options: a typo'd level
  // would otherwise fail nothing.
  if (failOnHttp !== undefined && !HTTP_FAIL_LEVELS.includes(failOnHttp)) {
    throw new Error(`chaosbringer: "failOnHttp" must be one of ${HTTP_FAIL_LEVELS.join(", ")} (got ${JSON.stringify(failOnHttp)})`);
  }

  // Construct the crawler before invoking the setup hook so that
  // CrawlerOptions validation (bad maxPages, malformed fault regex,
  // invalid shard settings, …) runs first. Otherwise a user-visible
  // side effect — typically a backend seed POST — fires for runs that
  // would then fail validation, mutating state that should never have
  // been touched. ChaosCrawler's constructor is side-effect-free; the
  // browser doesn't start until .start(), so the re-ordering is safe.
  const crawler = new ChaosCrawler({ ...crawlerOptions, server }, events);

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

  const exitCode = getExitCode(report, {
    strict,
    baselineStrict,
    http: failOnHttp,
    network: failOnNetwork,
    deadLinks: failOnDeadLinks,
  });
  return { report, passed: exitCode === 0, exitCode };
}

export { diffReports, loadBaseline, hasRegressions };
