/**
 * chaosbringer
 *
 * Playwright-based chaos testing library for web applications.
 * Inspired by monkey testing with additional features for error detection and reporting.
 */

// Core
export { ChaosCrawler, COMMON_IGNORE_PATTERNS, validateOptions } from "./crawler.js";
export { formatReport, formatCompactReport, saveReport, printReport, getExitCode, type ExitCodeOptions } from "./reporter.js";
export { Logger, createNullLogger, type LogEntry, type LogLevel, type LoggerOptions } from "./logger.js";
export { chaos, type ChaosResult, type ChaosRunOptions } from "./chaos.js";
export { faults, type FaultHelperOptions, type LifecycleHelperOptions } from "./faults.js";
export {
  compileLifecycleFaults,
  executeLifecycleAction,
  lifecycleFaultName,
  lifecycleFaultsAtStage,
  lifecycleMatchesUrl,
  lifecycleStatsFrom,
  PlaywrightLifecycleExecutor,
  shouldFireProbability,
  type CompiledLifecycleFault,
  type LifecycleActionExecutor,
} from "./lifecycle-faults.js";
export { clusterErrors, fingerprintError, type ErrorCluster } from "./clusters.js";
export { diffReports, loadBaseline, hasRegressions } from "./diff.js";
export { checkPerformanceBudget } from "./budget.js";
export { invariants, axe, buildAxeRunPayload, formatAxeViolations, type AxeInvariantOptions } from "./invariants.js";
export {
  stateMachineCurrent,
  stateMachineInvariant,
  stateMachineKey,
  validateTransition,
  type StateMachineDeriveContext,
  type StateMachineInvariantOptions,
  type TransitionVerdict,
} from "./state-machine-invariants.js";
export {
  compareScreenshotBuffers,
  formatVisualDiff,
  screenshotFilename,
  visualRegression,
  type CompareResult,
  type VisualRegressionOptions,
} from "./visual.js";
export {
  TRACE_FORMAT_VERSION,
  actionToTraceEntry,
  groupTrace,
  metaOf,
  parseTrace,
  readTrace,
  serializeTrace,
  writeTrace,
  type TraceAction,
  type TraceEntry,
  type TraceGroup,
  type TraceMeta,
  type TraceVisit,
} from "./trace.js";
export {
  ddmin,
  minimizeTrace,
  reportMatches,
  traceWithActions,
  type MinimizeOptions,
  type MinimizeResult,
} from "./minimize.js";
export {
  flakeReport,
  formatFlakeReport,
  type FlakeAnalysis,
  type ClusterOccurrence,
  type PageOccurrence,
} from "./flake.js";
export {
  buildGithubAnnotations,
  formatGithubAnnotation,
  printGithubAnnotations,
  type AnnotationLine,
} from "./github.js";
export { fnv1a, mergeReports, parseShardArg, shardOwns } from "./shard.js";
export { buildActionHeatmap, formatHeatmap, type ActionHeatmapEntry } from "./heatmap.js";
export { buildJunitXml, type JunitOptions } from "./junit.js";
export { parseMetaRefreshUrl } from "./links.js";
export {
  buildReproScript,
  failureBundleKey,
  shouldSaveArtifacts,
  writeFailureBundle,
  type FailureBundleInfo,
  type WriteFailureBundleArgs,
} from "./failure-artifacts.js";

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
  LifecycleAction,
  LifecycleFault,
  LifecycleFaultStats,
  LifecycleStage,
  StorageScope,
  UrlMatcher,
  HarConfig,
  HarMode,
  NetworkProfile,
  PerformanceBudget,
  PerfBudgetKey,
  ReportDiff,
  ClusterDiffEntry,
  PageDiffEntry,
  FailureArtifactsOptions,
} from "./types.js";
export { NETWORK_PROFILES, PERF_BUDGET_KEYS } from "./types.js";
export { networkConditionsFor, type NetworkConditions } from "./network.js";
export {
  fetchSitemapUrls,
  isSitemapIndex,
  parseSitemap,
  type FetchSitemapOptions,
} from "./sitemap.js";
