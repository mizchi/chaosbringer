/**
 * chaosbringer
 *
 * Playwright-based chaos testing library for web applications.
 * Inspired by monkey testing with additional features for error detection and reporting.
 */

// Core
export { ChaosCrawler, COMMON_IGNORE_PATTERNS, validateOptions } from "./crawler.js";
export { formatReport, formatCompactReport, saveReport, printReport, getExitCode } from "./reporter.js";
export { Logger, createNullLogger, type LogEntry, type LogLevel, type LoggerOptions } from "./logger.js";
export { chaos, type ChaosResult, type ChaosRunOptions } from "./chaos.js";
export { faults, type FaultHelperOptions } from "./faults.js";
export { clusterErrors, fingerprintError, type ErrorCluster } from "./clusters.js";

// Playwright Test integration
export { chaosTest, withChaos, runChaosTest, chaosExpect, type ChaosFixture, type ChaosFixtures } from "./fixture.js";

// Types
export type {
  CrawlerOptions,
  CrawlerEvents,
  ChaosTestOptions,
  PageResult,
  PageError,
  ActionResult,
  ActionTarget,
  ActionWeights,
  PerformanceMetrics,
  CrawlReport,
  CrawlSummary,
  Invariant,
  InvariantContext,
  Fault,
  FaultRule,
  FaultInjectionStats,
  UrlMatcher,
  HarConfig,
  HarMode,
} from "./types.js";
