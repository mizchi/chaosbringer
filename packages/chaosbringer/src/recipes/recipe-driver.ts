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

/**
 * Aggregated per-run telemetry for one recipe. "Per-run" means
 * since this driver instance was created — closed over a closure
 * that the recipeDriver maintains. Distinct from `ActionRecipe.stats`
 * (lifetime across all runs).
 */
export interface RecipeRunStats {
  name: string;
  /** Number of times the driver fired this recipe in the current run. */
  fired: number;
  succeeded: number;
  failed: number;
  /** Mean of succeeded-run durations. */
  avgDurationMs: number;
  /** Earliest firing in this run (ms since epoch). */
  firstFiredAt: number;
  /** Latest firing in this run. */
  lastFiredAt: number;
}

/**
 * Public surface for a recipeDriver. Adds `getRunStats()` on top of
 * the base Driver interface — issue #92's observability hook.
 */
export interface RecipeDriverInstance extends Driver {
  /**
   * Per-recipe firing counts since this driver instance was created.
   * Snapshot — caller mutations don't leak.
   */
  getRunStats(): RecipeRunStats[];
}

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

export function recipeDriver(opts: RecipeDriverOptions): RecipeDriverInstance {
  const log = opts.verbose ? (msg: string) => console.log(`[recipeDriver] ${msg}`) : () => {};
  const source = opts.source ?? "recipe";
  const chain = opts.chainRequires !== false;
  // Per-Page memory of which recipes already ran in this session.
  // WeakMap so closed pages don't leak.
  const sessionReplayed = new WeakMap<DriverStep["page"], Set<string>>();
  // Per-run firing log — populated each time `perform()` runs a recipe
  // (whether through the fast path or the chain). Aggregated on demand.
  const firings: Array<{
    name: string;
    succeeded: boolean;
    durationMs: number;
    timestamp: number;
  }> = [];
  const recordFiring = (name: string, succeeded: boolean, durationMs: number): void => {
    firings.push({ name, succeeded, durationMs, timestamp: Date.now() });
  };

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
                recordFiring(recipe.name, true, result.durationMs);
                log(`replayed ${recipe.name} ok (${result.durationMs.toFixed(0)}ms)`);
                return { ...base, success: true } satisfies ActionResult;
              }
              opts.store.recordFailure(recipe.name);
              recordFiring(recipe.name, false, result.durationMs);
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
                    recordFiring(ev.recipe, ev.result.ok, ev.result.durationMs);
                    log(
                      `${ev.recipe}: ${ev.result.ok ? "ok" : "FAIL"} (${ev.result.durationMs.toFixed(0)}ms)`,
                    );
                  } else if (ev.kind === "skip") {
                    log(`${ev.recipe}: skipped (${ev.reason})`);
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
    getRunStats(): RecipeRunStats[] {
      return aggregateFirings(firings);
    },
  };
}

/**
 * Group a flat firing log by recipe name and compute the public
 * RecipeRunStats shape. Stable order: most-fired first, then alpha.
 */
export function aggregateFirings(
  firings: ReadonlyArray<{
    name: string;
    succeeded: boolean;
    durationMs: number;
    timestamp: number;
  }>,
): RecipeRunStats[] {
  const grouped = new Map<string, RecipeRunStats & { _successDurations: number[] }>();
  for (const f of firings) {
    let entry = grouped.get(f.name);
    if (!entry) {
      entry = {
        name: f.name,
        fired: 0,
        succeeded: 0,
        failed: 0,
        avgDurationMs: 0,
        firstFiredAt: f.timestamp,
        lastFiredAt: f.timestamp,
        _successDurations: [],
      };
      grouped.set(f.name, entry);
    }
    entry.fired += 1;
    entry.lastFiredAt = Math.max(entry.lastFiredAt, f.timestamp);
    entry.firstFiredAt = Math.min(entry.firstFiredAt, f.timestamp);
    if (f.succeeded) {
      entry.succeeded += 1;
      entry._successDurations.push(f.durationMs);
    } else {
      entry.failed += 1;
    }
  }
  const out: RecipeRunStats[] = [];
  for (const entry of grouped.values()) {
    const total = entry._successDurations.reduce((a, b) => a + b, 0);
    out.push({
      name: entry.name,
      fired: entry.fired,
      succeeded: entry.succeeded,
      failed: entry.failed,
      avgDurationMs: entry._successDurations.length > 0 ? total / entry._successDurations.length : 0,
      firstFiredAt: entry.firstFiredAt,
      lastFiredAt: entry.lastFiredAt,
    });
  }
  out.sort((a, b) => {
    if (b.fired !== a.fired) return b.fired - a.fired;
    return a.name.localeCompare(b.name);
  });
  return out;
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
