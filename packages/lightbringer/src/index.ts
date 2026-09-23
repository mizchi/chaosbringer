// lightbringer — per-step web performance measurement for Playwright.
export { test, expect } from "./fixture";
export { PerfController, startSession, logSummary } from "./collector";
export type {
  Settle,
  Budget,
  VitalsBudget,
  PerfReport,
  SpanReport,
  AppSpanReport,
  CssProfile,
  MediaReport,
  RenderBlocking,
  SessionOptions,
  PerfSession,
} from "./collector";
// Per-domain report fragment types come from the analyze layer (also importable
// directly as `lightbringer/analyze` alongside the pure builder functions).
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
