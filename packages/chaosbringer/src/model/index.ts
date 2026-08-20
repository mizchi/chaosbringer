/**
 * Model-driven fault coverage: Quint (or any ITF producer) enumerates the
 * failure-mode state space, and each enumerated state replays here as a
 * deterministic run with the model's prediction as the oracle.
 *
 *   spec.qnt --quint verify--> ITF traces --compilePlan--> plans --runPlans--> verdict
 *
 * Only the last arrow needs this package; enumeration is a dev-time step and
 * plans are committed artifacts, so CI runs plans without Quint or a JVM.
 * See docs/superpowers/specs/2026-08-20-quint-model-driven-promise-faults-design.md.
 */

export {
  decodeItfValue,
  finalState,
  parseItfJson,
  parseItfTrace,
  readBool,
  readString,
  unwrapVariant,
  type ItfState,
  type ItfTrace,
  type ItfValue,
} from "./itf.js";

export {
  compilePlan,
  markOrderSensitivePlans,
  validatePlan,
  DEFAULT_ACTION_OUTCOMES,
  DEFAULT_IGNORED_ACTIONS,
  PLAN_OUTCOMES,
  type CompilePlanOptions,
  type FaultPlan,
  type PlanExpectation,
  type PlanOutcome,
  type PlanStep,
} from "./plan.js";

export {
  compilePlanFaults,
  faultNameFor,
  runPlan,
  runPlans,
  type MismatchField,
  type PlanMismatch,
  type PlanRunResult,
  type RunPlanOptions,
} from "./runner.js";

export {
  aggregateCoverage,
  failingPlans,
  findCollapsedPlans,
  formatModelCoverage,
  modelRunPassed,
  type AggregateCoverageOptions,
  type ModelCoverage,
  type TargetOutcome,
} from "./coverage.js";
