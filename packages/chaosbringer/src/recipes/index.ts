/**
 * Recipe layer — AI-grown, JSON-backed skill library that sits on top
 * of the existing driver framework. See `docs/cookbook/ai-recipe-skills.md`
 * for the user-facing guide.
 */
export type {
  ActionRecipe,
  ActionTrace,
  ExpectClause,
  Goal,
  GoalBudget,
  GoalContext,
  RecipeOrigin,
  RecipePrecondition,
  RecipeStats,
  RecipeStatus,
  RecipeStep,
  ReplayResult,
} from "./types.js";
export { emptyStats } from "./types.js";
export { RecipeStore, type RecipeStoreOptions, recipeFilename } from "./store.js";
export { preconditionsHold } from "./match.js";
export { runRecipe } from "./replay.js";
export { extractCandidate, type ExtractCandidateOptions } from "./capture.js";
export { verifyAndPromote, type VerifyOptions, type VerifyResult } from "./verify.js";
export {
  bugHuntingGoal,
  completionGoal,
  completionByUrl,
  completionBySelector,
  coverageGoal,
  goals,
  type BugHuntingGoalOptions,
  type CompletionGoalOptions,
  type CoverageGoalOptions,
} from "./goals.js";
export { recipeDriver, type RecipeDriverOptions } from "./recipe-driver.js";
export {
  tracingDriver,
  type TracingDriver,
  type TracingDriverOptions,
} from "./tracing-driver.js";
export {
  discoverCandidates,
  investigate,
  type InvestigateOptions,
  type InvestigateResult,
} from "./investigate.js";
export {
  investigateGoal,
  type FailureContext,
  type InvestigateGoalOptions,
} from "./goals.js";
