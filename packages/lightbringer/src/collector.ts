// ---------------------------------------------------------------------------
// Internal barrel kept for older internal imports; new code imports "./core".
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
// ---------------------------------------------------------------------------
export * from "./core";
