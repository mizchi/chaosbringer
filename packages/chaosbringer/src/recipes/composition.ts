/**
 * Recipe composition — `requires` chaining.
 *
 * A recipe with `requires: ["auth/login"]` should run the dependency
 * first whenever it gets replayed in a fresh session. This module
 * resolves the transitive dependency graph (topologically sorted,
 * cycle-checked) and runs each piece in order, skipping anything that
 * already ran in this session.
 *
 * "Session" is per-Page: a WeakMap keyed by the Playwright `Page`
 * handle. New page = clean slate. This matches how scenarioLoad
 * workers and the chaos crawler treat browser context boundaries.
 *
 * Failure mode: if a dependency fails, the dependent is **not**
 * attempted — the caller's `RunWithRequiresResult.failedAt` carries
 * the name of the recipe that broke, so reporting is easy.
 */
import type { Page } from "playwright";
import { runRecipe } from "./replay.js";
import type { RecipeStore } from "./store.js";
import type { ActionRecipe, ReplayResult } from "./types.js";

export interface RunWithRequiresOptions {
  page: Page;
  recipe: ActionRecipe;
  store: RecipeStore;
  /**
   * Names of recipes already replayed in this session. The runner
   * skips anything in this set. Caller maintains the set across
   * iterations — typical pattern is a per-Page or per-context
   * `Set<string>`. Passing `undefined` re-runs every dependency.
   */
  alreadyRan?: Set<string>;
  /** Fires before each recipe in the chain starts. */
  onProgress?: (event: ChainProgressEvent) => void;
}

export type ChainProgressEvent =
  | { kind: "start"; recipe: string; index: number; total: number }
  | { kind: "skip"; recipe: string; reason: "already-ran" }
  | { kind: "complete"; recipe: string; result: ReplayResult };

export interface RunWithRequiresResult {
  /** True when every recipe in the chain (skipped or run) succeeded. */
  ok: boolean;
  /** Names in execution order. Includes "already-ran" skips. */
  ranSequence: string[];
  /**
   * Name of the recipe whose replay failed, if any. The dependent
   * recipe(s) after it are NOT attempted. `null` on full success.
   */
  failedAt: string | null;
  /** Per-recipe replay results, keyed by name. */
  results: Record<string, ReplayResult>;
}

/**
 * Replay `recipe` after running every transitive dependency in its
 * `requires` list. Mutates `alreadyRan` (if provided) so a caller
 * can amortise the chain cost across multiple replays in the same
 * session.
 */
export async function runRecipeWithRequires(
  opts: RunWithRequiresOptions,
): Promise<RunWithRequiresResult> {
  const order = resolveDependencies(opts.recipe, opts.store);
  const alreadyRan = opts.alreadyRan ?? new Set<string>();
  const ranSequence: string[] = [];
  const results: Record<string, ReplayResult> = {};

  for (let i = 0; i < order.length; i++) {
    const r = order[i]!;
    ranSequence.push(r.name);
    if (alreadyRan.has(r.name)) {
      opts.onProgress?.({ kind: "skip", recipe: r.name, reason: "already-ran" });
      continue;
    }
    opts.onProgress?.({ kind: "start", recipe: r.name, index: i, total: order.length });
    const result = await runRecipe(opts.page, r);
    results[r.name] = result;
    opts.onProgress?.({ kind: "complete", recipe: r.name, result });
    if (result.ok) {
      alreadyRan.add(r.name);
      continue;
    }
    return { ok: false, ranSequence, failedAt: r.name, results };
  }

  return { ok: true, ranSequence, failedAt: null, results };
}

/**
 * Topologically sort `recipe` + its transitive `requires`. Throws on
 * a cycle (recipes that depend on each other), an unresolved name
 * (recipe X requires Y but Y is not in the store), or a self-loop.
 *
 * Returns recipes in execution order: dependencies first, then the
 * recipe itself last.
 */
export function resolveDependencies(
  recipe: ActionRecipe,
  store: RecipeStore,
): ActionRecipe[] {
  const order: ActionRecipe[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(name: string, parents: ReadonlyArray<string>): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      const cycle = [...parents, name].join(" → ");
      throw new Error(`resolveDependencies: cycle in requires chain (${cycle})`);
    }
    const r = store.get(name) ?? (name === recipe.name ? recipe : null);
    if (!r) {
      throw new Error(
        `resolveDependencies: recipe "${name}" is required by "${parents.at(-1) ?? "?"}" but not found in store`,
      );
    }
    visiting.add(name);
    const requires = r.requires.filter((dep) => !dep.startsWith("__"));
    for (const dep of requires) {
      if (dep === name) {
        throw new Error(`resolveDependencies: recipe "${name}" cannot require itself`);
      }
      visit(dep, [...parents, name]);
    }
    visiting.delete(name);
    visited.add(name);
    order.push(r);
  }

  visit(recipe.name, []);
  return order;
}
