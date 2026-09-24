// lightbringer/core — the runner-agnostic measurement API. Nothing in this
// module's import graph imports @playwright/test (only `playwright` types), so a
// crawler or any custom driver can use it with a plain Page + CDPSession. The
// @playwright/test fixture lives behind `lightbringer/fixture` (and `.`).
//
// Measures the "after interaction" performance of a scenario. Each measured
// region (span) is broken down into network (CDP), cpu (long task / LoAF) and
// render (CDP metrics). All times are unified to epoch ms: spans use the
// collector's captured performance.timeOrigin + performance.now(), in-page
// entries are shifted with their own document's timeOrigin at drain time, and
// CDP network uses wallTime — so they line up across navigations.
//
//   - config.ts ......... sessionOptionsFromEnv (the PERF_* env edge), web-vitals
//   - report-types.ts ... the contract layer (Budget / SpanReport / PerfReport)
//   - browser.ts ........ the document-start collector injected into the page
//   - accumulator.ts .... node-side store of drained entries (pure)
//   - controller.ts ..... PerfController (begin/end/measure, settle, GC, drain)
//   - capture.ts ........ CDP network + Chrome trace capture
//   - report.ts ......... buildReport + logSummary (report assembly / output)
//   - session.ts ........ startSession (orchestration) + the browser readers
export {
  startSession,
  collectorInitScript,
  EMIT_BINDING,
} from "./session";
export type { SessionOptions, PerfSession } from "./session";
export { PerfController, defaultSettle } from "./controller";
export type { PerfControllerOptions, SpanHandle, RawSpan } from "./controller";
export { buildReport, logSummary } from "./report";
export { checkBudgets, BUDGET_METRIC } from "./report-types";
export type {
  Budget,
  BudgetMetric,
  SpanReport,
  AppSpanReport,
  VitalsBudget,
  PerfReport,
  DocumentReport,
  CssProfile,
  MediaReport,
  RenderBlocking,
  Settle,
} from "./report-types";
export { sessionOptionsFromEnv, webVitalsIife } from "./config";
export {
  netProfileByName,
  NET_PROFILES,
  DEFAULT_SETTLE_TIMEOUT_MS,
  DEFAULT_EVALUATE_TIMEOUT_MS,
} from "./defaults";
export { BoundedEvaluator } from "./evaluate";
export type { EvaluateOutcome } from "./evaluate";
export type { EnvSessionOptions } from "./config";
export type { NetProfile } from "./defaults";
export { PerfAccumulator, accumulateSnapshot } from "./accumulator";
export type {
  AccumulatedEntries,
  DocumentVitalsRaw,
  EpochLongTask,
  EpochLoaf,
  EpochMeasure,
} from "./accumulator";
export type {
  CollectorOptions,
  DrainPayload,
  PerfStore,
  PerfWindow,
  BrowserMetric,
  LongTaskEntry,
} from "./browser";
// Per-domain report fragment types (also in `lightbringer/analyze`).
export type {
  SpanNetwork,
  SpanCpu,
  SpanRender,
  SpanMemory,
  SpanInteraction,
  SpanFrames,
  NetworkReport,
  VitalSample,
  Coverage,
  CoverageReport,
  MemoryTrend,
  Initiator,
} from "./analyze";
export { startSpan, withSpan } from "./trace";
export type { Span } from "./trace";
export { toOtelSpans } from "./otel";
export type { OtelSpan, PerfMeasureLike, AttrValue } from "./otel";
// Repeated-run statistics, budget gates, regression gate, trace drilldown and
// coverage union: the pure logic behind scripts/*.mjs and `lightbringer run
// --emit-budgets/--gate`, for any driver that has run reports (a crawler too).
export {
  percentile,
  median,
  stat,
  isNoisy,
  formatStat,
  aggregateRuns,
  formatMedianSummary,
  gate,
  formatGateViolation,
  formatGateWarning,
  checkMedianBudgets,
  spanMedians,
  emitBudgets,
  MEDIAN_BUDGET_STAT,
  EMIT_BUDGET_METRICS,
  NOISY_IQR_RATIO,
  NOISY_MIN_MEDIAN,
  DEFAULT_BUDGET_HEADROOM,
} from "./stats";
export type {
  Stat,
  MedianSpan,
  MedianAppSpan,
  MedianReport,
  RunReport,
  Gateable,
  GateFinding,
  GateResult,
  SpanMedians,
} from "./stats";
export {
  regress,
  classifyChange,
  relativeChange,
  formatPct,
  formatRegress,
  REGRESS_SPAN_METRICS,
  REGRESS_VITAL_METRICS,
  DEFAULT_REGRESS_THRESHOLD,
} from "./regress";
export type {
  RegressOptions,
  RegressInput,
  MedianSet,
  RegressLine,
  SlugRegress,
  RegressFinding,
  RegressResult,
  RegressSpanMetric,
  Change,
  ChangeKind,
} from "./regress";
export {
  analyseDrilldown,
  formatDrilldown,
  HARNESS_FRAME_NAMES,
  DRILLDOWN_TOP_N,
} from "./drilldown";
export type {
  DrilldownAnalysis,
  DrilldownSpan,
  DrilldownTraceEvent,
  FrameKind,
  NamedTotal,
  SelfFrame,
  SelectorCost,
} from "./drilldown";
export {
  unionCoverage,
  mergeCoverageArtifacts,
  formatCoverageUnion,
  COVERAGE_MIN_FLAG_BYTES,
  DEFAULT_COVERAGE_MIN_PCT,
} from "./coverage-union";
export type {
  CoverageArtifact,
  CoverageUnion,
  CoverageUnionKind,
  CoverageUnionRow,
} from "./coverage-union";
// Leak detection over repeated steps. A crawl repeats the same step (the same
// nav click on every page) without a measureRepeat, so it names its spans
// `<key>#<i>` and reuses the same climb detection.
export { buildTrends } from "./analyze/memory";
