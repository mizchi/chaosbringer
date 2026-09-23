// ---------------------------------------------------------------------------
// Per-step performance collector for Playwright. This module is a thin barrel
// over the split-out layers so the public surface (index.ts, fixture.ts, cli.ts,
// autowrap.ts) keeps importing from "./collector".
//
// Measures the "after interaction" performance of a scenario. Each measured
// region (span) is broken down into:
//   - network (CDP) ........ how long fetches blocked the step
//   - cpu (long task / LoAF) how long the main thread was occupied
//   - render (CDP metrics) . style recalc / layout / paint / GPU
// so that the only way to move the number is to change the implementation,
// not how the test waits.
//
// All times are unified to epoch ms for correlation. Spans use
// performance.timeOrigin + performance.now(); CDP network uses wallTime; both
// derive from the system clock, so they line up across navigations.
//
// The pieces live in:
//   - config.ts ......... PERF_* env knobs (WEB_VITALS_IIFE, NET_PROFILE, ...)
//   - report-types.ts ... the contract layer (Budget / SpanReport / PerfReport)
//   - browser.ts ........ the document-start collector injected into the page
//   - controller.ts ..... PerfController (span boundaries, settle, GC)
//   - capture.ts ........ CDP network + Chrome trace capture
//   - report.ts ......... buildReport + logSummary (report assembly / output)
//   - session.ts ........ startSession (orchestration) + the browser readers
// The CDP/Performance-event analysis itself is the framework-agnostic `analyze`
// layer (pure functions, separately unit-tested).
//
// The Playwright fixture (`test` / `expect`) lives in src/fixture.ts so this core
// stays free of an @playwright/test runtime import.
// ---------------------------------------------------------------------------

export {
  PERF_OUT_DIR,
  CSS_STATS,
  COV_ENABLED,
  TRACE_ENABLED,
  CPU_RATE,
  MEM_GC,
  NET_PROFILE,
} from "./config";
export { checkBudgets } from "./report-types";
export type {
  Budget,
  SpanReport,
  AppSpanReport,
  VitalsBudget,
  PerfReport,
  CssProfile,
  MediaReport,
  RenderBlocking,
  Settle,
} from "./report-types";
export { PerfController } from "./controller";
export { logSummary } from "./report";
export { startSession } from "./session";
export type { SessionOptions, PerfSession } from "./session";
