// Types
export type {
  Fault,
  FaultInjectionStats,
  FaultRule,
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
