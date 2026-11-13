export { createFaultEgress, DEFAULT_MAX_DELAY_MS, MAX_DELAY_CAP_MS } from "./egress.js";
export { INJECTED_ABORT_MARKER, KitesurfFaultsError, type KitesurfFaultsErrorCode } from "./errors.js";
export type {
  Fault,
  FaultEgressOptions,
  FaultEgressSession,
  FaultInjectionStats,
  FaultRule,
  FaultSchedule,
  FetchTransport,
} from "./types.js";
