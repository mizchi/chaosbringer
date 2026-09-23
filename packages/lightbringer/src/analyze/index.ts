// lightbringer/analyze — the framework-agnostic CDP/Performance-event analysis
// layer. Pure functions that turn raw CDP Network records, getMetrics deltas,
// trace events, coverage entries, and in-page timing arrays into report
// fragments. No Playwright / network / filesystem dependency; the collector
// (capture + report assembly) and the CLI build on top of these.
export { round } from "./util";
export type { EpochWindow } from "./util";

export {
  shortenUrl,
  summarizeInitiator,
  hostOf,
  registrableDomain,
  isThirdParty,
  unionLength,
  countWaves,
  buildThirdParty,
  buildInitiators,
  buildGlobalNetwork,
  buildSpanNetwork,
} from "./network";
export type {
  Initiator,
  InitiatorStat,
  ThirdPartyBreakdown,
  SpanNetwork,
  NetworkReport,
  NetReq,
  CdpInitiator,
} from "./network";

export { diffMetrics, buildTraceRender, buildSpanCpu } from "./render";
export type { SpanRender, SpanCpu, TraceEvent } from "./render";

export { diffMemory, buildTrends } from "./memory";
export type { SpanMemory, MemoryTrend } from "./memory";

export { mergeRanges, jsUsedRanges, buildCoverage } from "./coverage";
export type {
  CoverageFile,
  CoverageReport,
  Coverage,
  CoverageArtifact,
  JSCoverageEntry,
  CSSCoverageEntry,
} from "./coverage";

export { pickAttribution, buildSpanInteraction, buildSpanFrames } from "./vitals";
export type { VitalSample, SpanInteraction, SpanFrames, EpochEvent } from "./vitals";
