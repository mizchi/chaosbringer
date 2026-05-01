// Re-export shim. Implementation moved to @mizchi/playwright-faults (extracted Layer-1 package).
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
} from "@mizchi/playwright-faults";
