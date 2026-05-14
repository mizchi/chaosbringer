/**
 * Bridge between the Recipe layer and `scenarioLoad`. Lets a team
 * load-test their *entire verified-recipe library* without rewriting
 * each recipe as an imperative `defineScenario`.
 *
 * Two public entry points:
 *
 *   - `recipeStoreScenario({ store, ... })` — builds a single
 *     `Scenario` that, each iteration, picks one verified recipe
 *     from the store and replays it (composition + templating
 *     respected).
 *
 *   - `scenarioLoadFromStore({ baseUrl, store, workers, ... })` —
 *     thin wrapper that calls `scenarioLoad` with the scenario above.
 *
 * Selection strategies (`selection`):
 *   - `"uniform"` (default) — equal probability across candidates
 *   - `"by-success-rate"` — weighted by `successCount / total`, with
 *     a small floor so brand-new candidates aren't starved
 *   - custom: `(candidates, rng) => ActionRecipe` for full control
 *
 * Per-worker / per-iteration variables flow through `vars`:
 *   `vars: (workerIndex, iteration) => ({ email: ... })`
 */
import { defineScenario, type Scenario, type ScenarioContext } from "../load/index.js";
import { scenarioLoad } from "../load/index.js";
import type {
  DurationInput,
  ScenarioLoadOptions,
  ScenarioLoadResult,
  ThinkTime,
} from "../load/index.js";
import { runRecipeWithRequires } from "./composition.js";
import { runRecipe } from "./replay.js";
import type { RecipeStore } from "./store.js";
import type { RecipeVars } from "./templating.js";
import type { ActionRecipe } from "./types.js";

export type RecipeSelection =
  | "uniform"
  | "by-success-rate"
  | ((candidates: ReadonlyArray<ActionRecipe>, ctx: SelectionContext) => ActionRecipe);

export interface SelectionContext {
  workerIndex: number;
  iteration: number;
}

export interface RecipeStoreScenarioOptions {
  store: RecipeStore;
  /**
   * Filter applied on top of `status: "verified"`. Default: every
   * verified recipe is eligible.
   */
  filter?: (recipe: ActionRecipe) => boolean;
  /** Default: `"uniform"`. */
  selection?: RecipeSelection;
  /**
   * When true (default), each recipe's `requires` chain is resolved
   * automatically (matching `recipeDriver`'s default semantics).
   */
  chainRequires?: boolean;
  /**
   * Variables passed to every replay. A function form receives the
   * worker index + iteration so e.g. each iteration can use a fresh
   * email or user fixture.
   */
  vars?: RecipeVars | ((ctx: SelectionContext) => RecipeVars);
  /** Scenario name shown in `LoadReport.scenarios[]`. Default: `"recipe-mix"`. */
  scenarioName?: string;
  /** Optional per-iteration think time. Forwarded to `defineScenario`. */
  thinkTime?: ThinkTime;
}

/**
 * Builds a single `Scenario` whose only step picks a verified recipe
 * from the store and replays it. Designed to be passed to
 * `scenarioLoad({ scenarios: [{ scenario, workers }] })`.
 */
export function recipeStoreScenario(opts: RecipeStoreScenarioOptions): Scenario {
  const chain = opts.chainRequires !== false;
  const selection = opts.selection ?? "uniform";
  const filter = opts.filter ?? (() => true);
  const name = opts.scenarioName ?? "recipe-mix";

  // Per-worker memo: track which recipes already ran on this Page so
  // `requires` chains dedupe across iterations within the same worker.
  // (scenarioLoad gives each worker its own BrowserContext, so the
  // page object is stable for the worker's lifetime.)
  const workerMemo = new WeakMap<ScenarioContext["page"], Set<string>>();

  return defineScenario({
    name,
    thinkTime: opts.thinkTime,
    steps: [
      {
        name: "pick-and-replay",
        run: async (ctx) => {
          const candidates = opts.store.verified().filter(filter);
          if (candidates.length === 0) {
            throw new Error(
              `${name}: no verified recipes match filter — nothing to replay`,
            );
          }
          const selCtx: SelectionContext = {
            workerIndex: ctx.workerIndex,
            iteration: ctx.iteration,
          };
          const recipe = pickRecipe(candidates, selection, selCtx);
          const vars = resolveVars(opts.vars, selCtx);

          let memo = workerMemo.get(ctx.page);
          if (!memo) {
            memo = new Set();
            workerMemo.set(ctx.page, memo);
          }

          if (chain && recipe.requires.filter((d) => !d.startsWith("__")).length > 0) {
            const result = await runRecipeWithRequires({
              page: ctx.page,
              recipe,
              store: opts.store,
              alreadyRan: memo,
              vars,
              // Record stats for each link in the chain so the
              // store reflects every replay — mirrors recipeDriver.
              onProgress: (ev) => {
                if (ev.kind !== "complete") return;
                if (ev.result.ok) opts.store.recordSuccess(ev.recipe, ev.result.durationMs);
                else opts.store.recordFailure(ev.recipe);
              },
            });
            if (!result.ok) {
              throw new Error(
                `${name}: chain failed at ${result.failedAt} — ${result.results[result.failedAt!]?.failedAt?.reason ?? "unknown"}`,
              );
            }
            return;
          }
          const result = await runRecipe(ctx.page, recipe, { vars });
          if (result.ok) {
            opts.store.recordSuccess(recipe.name, result.durationMs);
          } else {
            opts.store.recordFailure(recipe.name);
            throw new Error(
              `${name}: recipe ${recipe.name} failed at step ${result.failedAt?.index} — ${result.failedAt?.reason ?? "unknown"}`,
            );
          }
        },
      },
    ],
  });
}

export interface ScenarioLoadFromStoreOptions extends RecipeStoreScenarioOptions {
  baseUrl: string;
  workers: number;
  duration?: DurationInput;
  rampUp?: DurationInput;
  faultInjection?: ScenarioLoadOptions["faultInjection"];
  runtimeFaults?: ScenarioLoadOptions["runtimeFaults"];
  invariants?: ScenarioLoadOptions["invariants"];
  headless?: boolean;
  timelineBucketMs?: number;
  maxIterationsPerWorker?: number;
  viewport?: ScenarioLoadOptions["viewport"];
  storageState?: string | ((workerIndex: number) => string | undefined);
}

/**
 * Top-level convenience: builds the scenario from the store and runs
 * `scenarioLoad` with the given concurrency / duration. Returns the
 * usual `ScenarioLoadResult` — chaos / SLO / timeline / fault stats
 * all work as normal.
 */
export async function scenarioLoadFromStore(
  opts: ScenarioLoadFromStoreOptions,
): Promise<ScenarioLoadResult> {
  const scenario = recipeStoreScenario(opts);
  return scenarioLoad({
    baseUrl: opts.baseUrl,
    duration: opts.duration,
    rampUp: opts.rampUp,
    scenarios: [
      {
        scenario,
        workers: opts.workers,
        storageState: opts.storageState,
      },
    ],
    faultInjection: opts.faultInjection,
    runtimeFaults: opts.runtimeFaults,
    invariants: opts.invariants,
    headless: opts.headless,
    timelineBucketMs: opts.timelineBucketMs,
    maxIterationsPerWorker: opts.maxIterationsPerWorker,
    viewport: opts.viewport,
  });
}

// -------- internals --------

function pickRecipe(
  candidates: ReadonlyArray<ActionRecipe>,
  strategy: RecipeSelection,
  ctx: SelectionContext,
): ActionRecipe {
  if (typeof strategy === "function") return strategy(candidates, ctx);
  if (strategy === "uniform") {
    const idx = Math.floor(Math.random() * candidates.length);
    return candidates[idx]!;
  }
  if (strategy === "by-success-rate") {
    // Weight each candidate by (successes + 1) / (total + 1) so a
    // brand-new candidate gets ~uniform weight, while a long-tested
    // reliable one wins more often. Capped weights so a single
    // 99%-reliable recipe doesn't crowd out everything else.
    const weights = candidates.map((r) => {
      const total = r.stats.successCount + r.stats.failCount;
      const rate = (r.stats.successCount + 1) / (total + 1);
      return Math.max(0.1, Math.min(1, rate));
    });
    return weightedPick(candidates, weights);
  }
  // Should be unreachable; fall back to uniform.
  return candidates[Math.floor(Math.random() * candidates.length)]!;
}

function weightedPick<T>(items: ReadonlyArray<T>, weights: ReadonlyArray<number>): T {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return items[Math.floor(Math.random() * items.length)]!;
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

function resolveVars(
  vars: RecipeStoreScenarioOptions["vars"],
  ctx: SelectionContext,
): RecipeVars | undefined {
  if (!vars) return undefined;
  if (typeof vars === "function") return vars(ctx);
  return vars;
}
