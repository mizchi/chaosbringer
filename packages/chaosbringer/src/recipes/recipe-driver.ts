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
import { runRecipeWithRequires } from "./composition.js";
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
  /**
   * When true (default), `requires` dependencies are replayed in topo
   * order before the matched recipe runs. Set false for legacy
   * "metadata only" semantics — the runner will fire the matched
   * recipe directly even if its preconditions assume a logged-in
   * state.
   *
   * Already-replayed dependencies are tracked per-Page, so a single
   * `auth/login` recipe doesn't re-run for every dependent recipe
   * after it.
   */
  chainRequires?: boolean;
}

export function recipeDriver(opts: RecipeDriverOptions): Driver {
  const log = opts.verbose ? (msg: string) => console.log(`[recipeDriver] ${msg}`) : () => {};
  const source = opts.source ?? "recipe";
  const chain = opts.chainRequires !== false;
  // Per-Page memory of which recipes already ran in this session.
  // WeakMap so closed pages don't leak.
  const sessionReplayed = new WeakMap<DriverStep["page"], Set<string>>();

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
          reasoning:
            recipe.requires.length > 0 && chain
              ? `replay recipe ${recipe.name} (with ${recipe.requires.length} dep(s))`
              : `replay recipe ${recipe.name}`,
          perform: async (page) => {
            const base = {
              type: "click" as const,
              selector: `__recipe__::${recipe.name}`,
              target: recipe.name,
              timestamp: Date.now(),
            };

            if (!chain || recipe.requires.filter((d) => !d.startsWith("__")).length === 0) {
              // Fast path: no deps to resolve.
              const result = await runRecipe(page, recipe);
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
            }

            // Chained path: resolve + run dependencies first, then the
            // matched recipe. Stats are recorded per-recipe inside the
            // chain so a flaky dependency drags its own success rate
            // down, not the dependent.
            let replayed = sessionReplayed.get(page);
            if (!replayed) {
              replayed = new Set();
              sessionReplayed.set(page, replayed);
            }
            let chainOk = true;
            let chainErr = "";
            try {
              const out = await runRecipeWithRequires({
                page,
                recipe,
                store: opts.store,
                alreadyRan: replayed,
                onProgress: (ev) => {
                  if (ev.kind === "complete") {
                    if (ev.result.ok) {
                      opts.store.recordSuccess(ev.recipe, ev.result.durationMs);
                    } else {
                      opts.store.recordFailure(ev.recipe);
                    }
                    log(
                      `${ev.recipe}: ${ev.result.ok ? "ok" : "FAIL"} (${ev.result.durationMs.toFixed(0)}ms)`,
                    );
                  } else if (ev.kind === "skip") {
                    log(`${ev.recipe}: skipped (already-ran)`);
                  }
                },
              });
              if (!out.ok) {
                chainOk = false;
                const failed = out.failedAt!;
                const r = out.results[failed];
                chainErr = `chain failed at ${failed}: ${r?.failedAt?.reason ?? "unknown"}`;
              }
            } catch (err) {
              chainOk = false;
              chainErr = err instanceof Error ? err.message : String(err);
            }

            if (chainOk) {
              return { ...base, success: true } satisfies ActionResult;
            }
            return { ...base, success: false, error: `recipe:${recipe.name}: ${chainErr}` } satisfies ActionResult;
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
