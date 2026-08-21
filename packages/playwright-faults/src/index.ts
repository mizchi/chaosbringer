// Types
export type {
  Fault,
  FaultDecision,
  FaultInjectionStats,
  FaultRule,
  FaultSchedule,
  IframeAction,
  IframeFault,
  IframeFaultStats,
  LifecycleAction,
  LifecycleFault,
  LifecycleFaultStats,
  LifecycleStage,
  Rng,
  RuntimeAction,
  RuntimeFault,
  RuntimeFaultStats,
  StorageScope,
  UrlMatcher,
} from "./types.js";

// Network-level (FaultRule helpers + builders)
export {
  faults,
  type FaultHelperOptions,
  type IframeHelperOptions,
  type LifecycleHelperOptions,
  type RuntimeHelperOptions,
} from "./faults.js";

// Deterministic occurrence-indexed decisions (shared by all four layers)
export {
  buildDecisionHelperSource,
  decideFault,
  scheduleDecisionAt,
  serializeSchedule,
  validateFaultSchedule,
  type ScheduledFaultLike,
} from "./schedule.js";

// Runtime-level (addInitScript-based monkey patches)
export {
  buildRuntimeFaultsScript,
  compileRuntimeFaults,
  mergeRuntimeStats,
  runtimeFaultName,
  runtimeMatchesUrl,
  type CompiledRuntimeFault,
} from "./runtime-faults.js";

// Iframe-load (addInitScript-based monkey patches on HTMLIFrameElement)
export {
  buildIframeFaultsScript,
  compileIframeFaults,
  iframeFaultName,
  mergeIframeStats,
  type CompiledIframeFault,
} from "./iframe-faults.js";

// Page lifecycle (Playwright Page / BrowserContext at named stages)
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

// URL matching (shared by every layer, and by consumers that compile their own)
export { compileUrlMatcher, stripStatefulFlags } from "./url-matcher.js";
