/**
 * Recipe layer — a serialisable "skill library" that the AI driver can
 * grow over time. Every successful trajectory the AI executes against a
 * goal is a candidate recipe; verified recipes (≥ K successful re-runs)
 * are promoted into the store and replayed without LLM calls on
 * subsequent matches.
 *
 * Design constraints:
 * - **Recipes are JSON.** No closures, no functions. So they ship in
 *   git, get reviewed in PRs, and can be diffed.
 * - **Recipe steps are a discriminated union** of supported Playwright
 *   actions. We do NOT expose arbitrary `page.evaluate` strings — that
 *   would let an AI-extracted recipe execute attacker-controlled code
 *   after a single bad capture.
 * - **Stats live on the recipe** and update in-place when the store
 *   records a success/failure. Promotion / decay derives from these.
 */

export type RecipeOrigin =
  | "ai-extracted"   // captured from a successful AI-driver trajectory
  | "hand-written"   // authored by a human
  | "promoted-scenario" // converted from a `defineScenario` registration
  | "regression";    // produced by `investigate()` from a captured failure

/**
 * One executable step inside a recipe. Discriminated by `kind` so the
 * replayer can dispatch without `eval` and the JSON is reviewable.
 *
 * `expectAfter` is the post-step assertion that decides "did this step
 * actually work". Without it, a brittle recipe can silently progress
 * through a broken UI.
 */
export type RecipeStep =
  | { kind: "navigate"; url: string; expectAfter?: ExpectClause }
  | { kind: "click"; selector: string; expectAfter?: ExpectClause }
  | { kind: "fill"; selector: string; value: string; expectAfter?: ExpectClause }
  | { kind: "press"; key: string; selector?: string; expectAfter?: ExpectClause }
  | { kind: "select"; selector: string; value: string; expectAfter?: ExpectClause }
  | { kind: "wait"; ms: number }
  | { kind: "waitFor"; selector: string; timeoutMs?: number };

export interface ExpectClause {
  /** Substring that must appear in `page.url()` after the step. */
  urlContains?: string;
  /** Substring that must NOT appear in `page.url()` (good for "stayed on the same page" assertions). */
  urlNotContains?: string;
  /** Selector that must be visible after the step. */
  hasSelector?: string;
  /** Selector that must NOT be visible after the step. */
  hidesSelector?: string;
  /** How long to wait for the assertion before declaring failure. Default: 5000ms. */
  timeoutMs?: number;
}

/**
 * Conditions checked before replaying a recipe. ALL of `preconditions`
 * must hold; the recipe is otherwise skipped. Same shape as ExpectClause
 * minus the timeout (preconditions are immediate, not waited-for).
 */
export interface RecipePrecondition {
  urlPattern?: string;            // regex source
  hasSelector?: string;
  hidesSelector?: string;
}

export interface RecipeStats {
  successCount: number;
  failCount: number;
  /** Rolling mean of successful-run durations in ms. */
  avgDurationMs: number;
  lastSuccessAt: number | null;
  lastFailAt: number | null;
  /** Wall-clock ms of the slowest successful run (debugging signal). */
  maxDurationMs: number;
}

export function emptyStats(): RecipeStats {
  return {
    successCount: 0,
    failCount: 0,
    avgDurationMs: 0,
    lastSuccessAt: null,
    lastFailAt: null,
    maxDurationMs: 0,
  };
}

export interface ActionRecipe {
  /** Stable identifier. Convention: `domain/action`, e.g. `"shop/checkout"`. */
  name: string;
  /** Short prose summary — surfaced to the AI driver as recipe metadata. */
  description: string;
  /** Goal name this recipe was captured under (if any). */
  goal?: string;
  /** ALL preconditions must hold to consider replaying. */
  preconditions: RecipePrecondition[];
  steps: RecipeStep[];
  /** Optional assertions after the final step. Used during verification. */
  postconditions: RecipePrecondition[];
  /** Names of other recipes this recipe assumes have been replayed first. */
  requires: string[];
  stats: RecipeStats;
  origin: RecipeOrigin;
  /** Promotion phase, derived from stats. */
  status: RecipeStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export type RecipeStatus = "candidate" | "verified" | "demoted";

/**
 * A `Goal` is what we hand to the AI driver to operate towards. It is
 * also the unit of "did we succeed?" — `successCheck` is the gate that
 * decides whether a captured trajectory is a recipe candidate.
 *
 * Personas line up with the three core flavours: completion (a normal
 * user finishing a task), bug-hunting (an adversarial tester), and
 * coverage (a systematic explorer). Built-ins in `goals.ts`.
 */
export interface Goal {
  name: string;
  /** Sentence the AI uses to frame its prompt. Free-form. */
  persona: string;
  /** What the goal-holder is trying to do. The AI driver passes this through as `goal`. */
  objective: string;
  /** Returns true once the goal is achieved. Polled between actions. */
  successCheck: (ctx: GoalContext) => Promise<boolean>;
  /** Optional per-step / wall-clock budgets. */
  budget?: GoalBudget;
}

export interface GoalContext {
  /** Playwright page handle. */
  page: import("playwright").Page;
  /** URL at the moment of the check. */
  url: string;
  /** Steps executed so far, oldest first. */
  history: ReadonlyArray<RecipeStep>;
  /** Errors observed on the page so far. */
  errors: ReadonlyArray<{ message: string; timestamp: number }>;
}

export interface GoalBudget {
  /** Max number of steps before declaring failure. */
  maxSteps?: number;
  /** Max wall-clock ms. */
  maxBudgetMs?: number;
}

/**
 * Result of a recipe replay. The runner records this back into the
 * store via `recordSuccess` / `recordFailure`.
 */
export interface ReplayResult {
  ok: boolean;
  durationMs: number;
  /** Step index (0-based) and human-readable reason when ok=false. */
  failedAt?: { index: number; reason: string };
}

/**
 * Captured trajectory — produced by the trace collector after a goal
 * succeeds, fed to `extractCandidate()` to mint a Recipe.
 */
export interface ActionTrace {
  goal: string;
  steps: RecipeStep[];
  /** Snapshot of preconditions that held at the start. */
  startState: { url: string };
  /** Snapshot at the moment the goal succeeded. */
  endState: { url: string };
  /** Total wall-clock ms. */
  durationMs: number;
  successful: boolean;
}
