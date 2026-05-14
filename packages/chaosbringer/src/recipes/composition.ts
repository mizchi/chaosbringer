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
import {
  applySnapshot,
  captureSnapshot,
  loadSnapshot,
  DEFAULT_SNAPSHOT_TTL_MS,
} from "./snapshot.js";
import type { RecipeStore } from "./store.js";
import type { RecipeVars } from "./templating.js";
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
  /**
   * Variable bag forwarded to every replay in the chain. Templates
   * like `{{email}}` in any recipe's step values resolve from here.
   * The same bag is shared across the chain — `auth/login` and
   * `shop/checkout` see the same `{{email}}`.
   */
  vars?: RecipeVars;
  /**
   * Storage-state snapshot policy (issue #89). When enabled, recipes
   * marked as snapshotable have their storage state captured after
   * the first successful replay; subsequent replays in fresh
   * contexts inject the snapshot and skip the chain step entirely.
   *
   * Pass `false` (default) to disable the optimisation. Pass `true`
   * to use the default TTL (30 min). Pass an object to customise.
   */
  snapshot?: boolean | SnapshotPolicy;
}

export interface SnapshotPolicy {
  /** Time-to-live in milliseconds. Snapshots older than this are
   *  discarded and the chain step replays normally. Default: 30 min. */
  ttlMs?: number;
  /**
   * Predicate deciding which recipes are eligible for snapshot
   * capture. Defaults to "name starts with `auth/`" — the dominant
   * use case. Return false for recipes whose post-state is too
   * volatile or order-dependent to snapshot safely.
   */
  eligible?: (recipe: ActionRecipe) => boolean;
}

const DEFAULT_SNAPSHOT_ELIGIBLE = (r: ActionRecipe): boolean => r.name.startsWith("auth/");

export type ChainProgressEvent =
  | { kind: "start"; recipe: string; index: number; total: number }
  | { kind: "skip"; recipe: string; reason: "already-ran" | "snapshot-applied" }
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
 *
 * Storage-state snapshots (issue #89): when `opts.snapshot` is
 * enabled and the chain link is eligible (default: `name.startsWith("auth/")`),
 * a fresh-context replay attempts to apply a cached snapshot first.
 * Snapshot hit → chain link is skipped with `reason: "snapshot-applied"`.
 * Snapshot miss → chain link runs normally and the runner captures
 * a new snapshot after success.
 */
export async function runRecipeWithRequires(
  opts: RunWithRequiresOptions,
): Promise<RunWithRequiresResult> {
  const order = resolveDependencies(opts.recipe, opts.store);
  const alreadyRan = opts.alreadyRan ?? new Set<string>();
  const ranSequence: string[] = [];
  const results: Record<string, ReplayResult> = {};
  const snapshotPolicy = normaliseSnapshot(opts.snapshot);

  for (let i = 0; i < order.length; i++) {
    const r = order[i]!;
    ranSequence.push(r.name);
    if (alreadyRan.has(r.name)) {
      opts.onProgress?.({ kind: "skip", recipe: r.name, reason: "already-ran" });
      continue;
    }

    // Snapshot fast path: try to inject saved storage state. Only
    // applies to chain links earlier than the target recipe (the
    // last entry in `order`); the final entry must actually replay
    // to satisfy the caller's success expectations.
    const isTerminal = i === order.length - 1;
    if (
      snapshotPolicy &&
      !isTerminal &&
      snapshotPolicy.eligible(r) &&
      opts.store.writeDir
    ) {
      const snap = loadSnapshot(opts.store.writeDir, r.name, {
        recipeVersion: r.version,
        ttlMs: snapshotPolicy.ttlMs,
      });
      if (snap) {
        const applied = await applySnapshot(opts.page.context(), snap, {
          currentOrigin: originOf(opts.page.url()),
        });
        if (applied) {
          alreadyRan.add(r.name);
          opts.onProgress?.({
            kind: "skip",
            recipe: r.name,
            reason: "snapshot-applied",
          });
          continue;
        }
      }
    }

    opts.onProgress?.({ kind: "start", recipe: r.name, index: i, total: order.length });
    const result = await runRecipe(opts.page, r, { vars: opts.vars });
    results[r.name] = result;
    opts.onProgress?.({ kind: "complete", recipe: r.name, result });
    if (result.ok) {
      alreadyRan.add(r.name);
      // Successful chain link → snapshot if eligible.
      if (
        snapshotPolicy &&
        !isTerminal &&
        snapshotPolicy.eligible(r) &&
        opts.store.writeDir
      ) {
        await captureSnapshot(opts.page.context(), {
          name: r.name,
          recipeVersion: r.version,
          dir: opts.store.writeDir,
          origin: originOf(opts.page.url()),
        }).catch(() => {
          // best-effort — a failed snapshot must not fail the run
        });
      }
      continue;
    }
    return { ok: false, ranSequence, failedAt: r.name, results };
  }

  return { ok: true, ranSequence, failedAt: null, results };
}

function normaliseSnapshot(
  s: RunWithRequiresOptions["snapshot"],
): { ttlMs: number; eligible: (r: ActionRecipe) => boolean } | null {
  if (!s) return null;
  if (s === true) return { ttlMs: DEFAULT_SNAPSHOT_TTL_MS, eligible: DEFAULT_SNAPSHOT_ELIGIBLE };
  return {
    ttlMs: s.ttlMs ?? DEFAULT_SNAPSHOT_TTL_MS,
    eligible: s.eligible ?? DEFAULT_SNAPSHOT_ELIGIBLE,
  };
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
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
