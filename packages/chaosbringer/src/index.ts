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
export {
  faults,
  type FaultHelperOptions,
  type LifecycleHelperOptions,
  type RuntimeHelperOptions,
} from "./faults.js";
export { profiles } from "./profiles.js";
export {
  buildRuntimeFaultsScript,
  compileRuntimeFaults,
  mergeRuntimeStats,
  runtimeFaultName,
  runtimeMatchesUrl,
  type CompiledRuntimeFault,
} from "./runtime-faults.js";
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
  CoverageCollector,
  coverageDelta,
  coverageSignature,
  noveltyMultiplier,
  summarizeCoverage,
  targetKey,
  type CoverageScriptResult,
} from "./coverage.js";
export type {
  ActionAdvisor,
  AdvisorCandidate,
  AdvisorConfig,
  AdvisorConsultReason,
  AdvisorContext,
  AdvisorSuggestion,
} from "./advisor/types.js";
export { openRouterAdvisor, type OpenRouterAdvisorOptions } from "./advisor/openrouter.js";
export {
  advisorFallbackDriver,
  aiDriver,
  anthropicDriverProvider,
  boundaryValueProvider,
  combinePayloadSets,
  compositeDriver,
  defaultValueProvider,
  DEFAULT_PAYLOAD_SETS,
  DriverBudget,
  flowDriver,
  formDriver,
  fromList,
  HTML_INJECTION_PAYLOADS,
  LARGE_PAYLOADS,
  openRouterDriverProvider,
  PATH_TRAVERSAL_PAYLOADS,
  payloadDriver,
  probabilityDriver,
  samplingDriver,
  SQLI_PAYLOADS,
  TEMPLATE_INJECTION_PAYLOADS,
  UNICODE_PAYLOADS,
  weightedRandomDriver,
  XSS_PAYLOADS,
  type AdvisorFallbackOptions,
  type AiDriverOptions,
  type AnthropicDriverProviderOptions,
  type CompositeDriverOptions,
  type Driver,
  type DriverBudgetOptions,
  type DriverCandidate,
  type DriverHistoryEntry,
  type DriverInvariantViolation,
  type DriverPick,
  type DriverProvider,
  type DriverProviderInput,
  type DriverProviderResult,
  type DriverStep,
  type FieldValueProvider,
  type FlowDriverOptions,
  type FlowStep,
  type FormDriverOptions,
  type FormFieldInfo,
  type NoveltySignal,
  type OpenRouterDriverProviderOptions,
  type PayloadDriverOptions,
  type PayloadSetName,
  type ProbabilityDriverOptions,
  type SamplingDriverOptions,
  type ScreenshotMode,
  type WeightedRandomDriverOptions,
} from "./drivers/index.js";
export {
  parallelChaos,
  type ParallelChaosOptions,
  type ParallelChaosResult,
  type ParallelShardResult,
  type ParallelShardSpec,
} from "./parallel.js";
export {
  buildLoadReport,
  defineScenario,
  emptyLatencyStats,
  endpointKey,
  formatLoadReport,
  latencyStats,
  NetworkSampler,
  parseDurationMs,
  pickThinkTimeMs,
  quantile,
  scenarioLoad,
  type DurationInput,
  type EndpointReport,
  type LatencyStats,
  type LoadReport,
  type NetworkSample,
  type Scenario,
  type ScenarioContext,
  type ScenarioLoadOptions,
  type ScenarioLoadResult,
  type ScenarioReport,
  type ScenarioSpec,
  type ScenarioStep,
  type StepReport,
  type ThinkTime,
  type WorkerSummary,
} from "./load/index.js";
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
  RuntimeAction,
  RuntimeFault,
  RuntimeFaultStats,
  CoverageFeedbackOptions,
  CoverageReport,
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
  TraceparentInjectionOptions,
  ChaosRemoteServer,
  ServerFaultEvent,
} from "./types.js";
export { NETWORK_PROFILES, PERF_BUDGET_KEYS } from "./types.js";
export { networkConditionsFor, type NetworkConditions } from "./network.js";
export {
  fetchSitemapUrls,
  isSitemapIndex,
  parseSitemap,
  type FetchSitemapOptions,
} from "./sitemap.js";
