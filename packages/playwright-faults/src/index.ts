// Types
export type {
  Fault,
  FaultInjectionStats,
  FaultRule,
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
