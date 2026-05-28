// Re-export shim. Implementation moved to @mizchi/playwright-faults (extracted Layer-1 package).
export {
  buildIframeFaultsScript,
  compileIframeFaults,
  iframeFaultName,
  mergeIframeStats,
  type CompiledIframeFault,
} from "@mizchi/playwright-faults";
