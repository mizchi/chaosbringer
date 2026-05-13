/**
 * Scenario-load layer — light-weight load runner that drives realistic
 * user journeys with N persistent workers, optionally under chaos.
 *
 * Top-level entry: `scenarioLoad`. Define scenarios with
 * `defineScenario` and report on results via `formatLoadReport`.
 */
export { scenarioLoad, type ScenarioLoadResult } from "./scenario-load.js";
export { defineScenario, pickThinkTimeMs } from "./scenario.js";
export { buildLoadReport, formatLoadReport, sparkline } from "./report.js";
export { latencyStats, parseDurationMs, emptyLatencyStats, quantile } from "./histogram.js";
export { endpointKey, NetworkSampler, type NetworkSample } from "./sampler.js";
export type {
  DurationInput,
  EndpointReport,
  LatencyStats,
  LoadReport,
  Scenario,
  ScenarioContext,
  ScenarioLoadOptions,
  ScenarioReport,
  ScenarioSpec,
  ScenarioStep,
  StepReport,
  ThinkTime,
  TimelineBucket,
  WorkerSummary,
} from "./types.js";
