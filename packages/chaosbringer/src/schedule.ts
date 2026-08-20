// Re-export shim. Implementation lives in @mizchi/playwright-faults (extracted Layer-1 package).
export {
  buildDecisionHelperSource,
  decideFault,
  scheduleDecisionAt,
  serializeSchedule,
  validateFaultSchedule,
  type ScheduledFaultLike,
} from "@mizchi/playwright-faults";
