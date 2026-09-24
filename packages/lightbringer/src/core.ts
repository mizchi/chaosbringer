// lightbringer/core — the runner-agnostic measurement API. Nothing in this
// module's import graph imports @playwright/test (only `playwright` types), so a
// crawler or any custom driver can use it with a plain Page + CDPSession. The
// @playwright/test fixture lives behind `lightbringer/fixture` (and `.`).
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
export {
  sessionOptionsFromEnv,
  webVitalsIife,
  netProfileByName,
  NET_PROFILES,
  DEFAULT_SETTLE_TIMEOUT_MS,
  DEFAULT_EVALUATE_TIMEOUT_MS,
} from "./config";
export { BoundedEvaluator } from "./evaluate";
export type { EvaluateOutcome } from "./evaluate";
export type { EnvSessionOptions, NetProfile } from "./config";
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
  formatCoverageUnion,
  COVERAGE_MIN_FLAG_BYTES,
  DEFAULT_COVERAGE_MIN_PCT,
} from "./coverage-union";
export type { CoverageUnion, CoverageUnionKind, CoverageUnionRow } from "./coverage-union";
