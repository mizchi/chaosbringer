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
  checkUiInvariants,
  compilePlanFaults,
  evaluatePlanOracle,
  faultNameFor,
  fingerprintsOf,
  observationNameFor,
  resolvePlanTiming,
  runPlan,
  runPlans,
  validateCallCountRules,
  MISMATCH_FIELDS,
  type MismatchField,
  type PlanMismatch,
  type PlanOracleInput,
  type PlanRuleTarget,
  type PlanRunResult,
  type ResolvedPlanTiming,
  type RunPlanOptions,
  type UiInvariant,
} from "./runner.js";

export {
  classifyVerdict,
  fieldsOf,
  planWithSteps,
  shrinkCandidates,
  shrinkPlan,
  shrinkableFields,
  unrankedOutcomes,
  weakerOutcomes,
  INCONCLUSIVE_FIELDS,
  OUTCOME_STRENGTH,
  type ShrinkCandidate,
  type ShrinkOptions,
  type ShrinkResult,
  type ShrinkRunResult,
  type ShrinkStep,
  type ShrinkStop,
  type ShrinkVerdict,
} from "./shrink.js";

export {
  calibrateTiming,
  envelope,
  type CalibrateOptions,
  type CalibrationResult,
  type CalibrationRun,
  type CalibrationSample,
} from "./calibrate.js";

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
