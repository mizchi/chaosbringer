/**
 * `recipeDriver` — a `Driver` that consults the store first. If any
 * verified recipe matches the current page's preconditions, it returns
 * a `custom` pick that replays the recipe; otherwise it returns `null`
 * so the outer composite falls through to the AI / heuristic driver.
 *
 * This is the operational hot-path of the "skill library" — every
 * step starts here, and only the steps the store has NO answer for
 * cost an LLM call.
 *
 * Recipe priority when multiple match the same page:
 * 1. Higher success rate first (with a small bias for `successCount` to
 *    break ties between equally-good recipes).
 * 2. Shorter recipes first when rates tie (cheaper to verify, less
 *    invasive when wrong).
 *
 * The replay outcome is recorded back into the store so per-recipe
 * stats stay current.
 */
import type { ActionResult } from "../types.js";
import type { Driver, DriverPick, DriverStep } from "../drivers/types.js";
import { preconditionsHold } from "./match.js";
import { runRecipe } from "./replay.js";
import type { RecipeStore } from "./store.js";
import type { ActionRecipe } from "./types.js";

export interface RecipeDriverOptions {
  store: RecipeStore;
  /**
   * Restrict to recipes captured under this Goal. Recipes from other
   * goals are still in the store but ignored — keeps a "buy" recipe
   * from firing during a "bug-hunting" run.
   */
  goal?: string;
  /**
   * Pre-filter beyond status + goal. Useful for e.g. only replaying
   * recipes that haven't been seen this session.
   */
  filter?: (recipe: ActionRecipe) => boolean;
  /**
   * Console-log when a recipe fires / fails. Default: false. Surface
   * via the standard logger once we have one.
   */
  verbose?: boolean;
  /** Identifier surfaced in DriverPick.source. Default: `"recipe"`. */
  source?: string;
}

export function recipeDriver(opts: RecipeDriverOptions): Driver {
  const log = opts.verbose ? (msg: string) => console.log(`[recipeDriver] ${msg}`) : () => {};
  const source = opts.source ?? "recipe";

  return {
    name: "recipe",
    async selectAction(step: DriverStep): Promise<DriverPick | null> {
      const candidates = pickCandidates(opts.store, opts.goal, opts.filter);
      if (candidates.length === 0) return null;

      for (const recipe of candidates) {
        const ok = await preconditionsHold(step.page, recipe.preconditions);
        if (!ok) continue;
        log(`matched ${recipe.name}`);
        return {
          kind: "custom",
          source,
          reasoning: `replay recipe ${recipe.name}`,
          perform: async (page) => {
            const result = await runRecipe(page, recipe);
            const base = {
              type: "click" as const,
              selector: `__recipe__::${recipe.name}`,
              target: recipe.name,
              timestamp: Date.now(),
            };
            if (result.ok) {
              opts.store.recordSuccess(recipe.name, result.durationMs);
              log(`replayed ${recipe.name} ok (${result.durationMs.toFixed(0)}ms)`);
              return { ...base, success: true } satisfies ActionResult;
            }
            opts.store.recordFailure(recipe.name);
            log(`replayed ${recipe.name} FAIL at step ${result.failedAt?.index} — ${result.failedAt?.reason}`);
            return {
              ...base,
              success: false,
              error: `recipe:${recipe.name}: ${result.failedAt?.reason ?? "unknown"}`,
            } satisfies ActionResult;
          },
        };
      }
      return null;
    },
  };
}

function pickCandidates(
  store: RecipeStore,
  goal?: string,
  filter?: (r: ActionRecipe) => boolean,
): ActionRecipe[] {
  const all = store.verified();
  const scoped = goal ? all.filter((r) => !r.goal || r.goal === goal) : all;
  const filtered = filter ? scoped.filter(filter) : scoped;
  return filtered.slice().sort(compareRecipes);
}

function compareRecipes(a: ActionRecipe, b: ActionRecipe): number {
  const rateA = successRate(a);
  const rateB = successRate(b);
  if (rateA !== rateB) return rateB - rateA;
  // Tie-breaker: more successes wins (more "battle-tested").
  if (a.stats.successCount !== b.stats.successCount) {
    return b.stats.successCount - a.stats.successCount;
  }
  // Then shorter recipes win (less invasive on mismatch).
  return a.steps.length - b.steps.length;
}

function successRate(r: ActionRecipe): number {
  const total = r.stats.successCount + r.stats.failCount;
  return total === 0 ? 0 : r.stats.successCount / total;
}
