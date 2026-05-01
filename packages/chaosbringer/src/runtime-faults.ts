// Re-export shim. Implementation moved to @mizchi/playwright-faults (extracted Layer-1 package).
export {
  buildRuntimeFaultsScript,
  compileRuntimeFaults,
  mergeRuntimeStats,
  runtimeFaultName,
  runtimeMatchesUrl,
  type CompiledRuntimeFault,
} from "@mizchi/playwright-faults";
