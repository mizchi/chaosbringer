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
export { checkBudgets } from "./report-types";
export type {
  Budget,
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
} from "./config";
export type { EnvSessionOptions, NetProfile } from "./config";
export { PerfAccumulator, accumulateSnapshot } from "./accumulator";
export type {
  AccumulatedEntries,
  DocumentVitalsRaw,
  EpochLongTask,
  EpochLoaf,
  EpochMeasure,
} from "./accumulator";
export type { DrainPayload, PerfStore, PerfWindow, BrowserMetric } from "./browser";
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
