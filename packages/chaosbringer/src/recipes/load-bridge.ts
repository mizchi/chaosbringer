/**
 * Bridge between the Recipe layer and `scenarioLoad`. Lets a team
 * load-test their *entire verified-recipe library* without rewriting
 * each recipe as an imperative `defineScenario`.
 *
 * Two public entry points:
 *
 *   - `recipeStoreScenario({ store, ... })` — builds a single
 *     `Scenario` that, each iteration, picks one verified recipe
 *     (or one of `status`) from the store and replays it
 *     (composition + templating respected).
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
 *
 * Replays are not recorded into the store unless `record` is set: a load
 * test measures the site, and recording puts the failures of a site under
 * load, or of a host that is down, into the team's store, where they can
 * demote its verified recipes.
 */
import { defineScenario, type Scenario, type ScenarioContext } from "../load/index.js";
import { scenarioLoad } from "../load/index.js";
import { weightedPick, type Rng } from "../random.js";
import type {
  DurationInput,
  ScenarioLoadOptions,
  ScenarioLoadResult,
  ThinkTime,
} from "../load/index.js";
import { resolveDependencies, runRecipeWithRequires } from "./composition.js";
import { aggregateFirings, type RecipeRunStats } from "./recipe-driver.js";
import { runRecipe } from "./replay.js";
import type { RecipeStore } from "./store.js";
import type { RecipeVars } from "./templating.js";
import type { ActionRecipe, RecipeStatus } from "./types.js";

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
  /** The status a recipe needs to be eligible. Default: `"verified"`. */
  status?: RecipeStatus;
  /**
   * Filter applied on top of `status`. Default: every recipe of that
   * status is eligible.
   */
  filter?: (recipe: ActionRecipe) => boolean;
  /**
   * Record each replay's outcome into the store (`recordSuccess` /
   * `recordFailure`, as `recipeDriver` does), which promotes and demotes
   * recipes. Default: false — the store is left as it was.
   */
  record?: boolean;
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
 * Result shape returned by `recipeStoreScenarioWithStats`. The
 * scenario is what scenarioLoad wants; `getRunStats()` is the
 * issue #92 observability hook for callers that want to know "which
 * recipes fired during this load run."
 *
 * `recipeStoreScenario` (no `WithStats`) is retained as the legacy
 * scenario-only entry point.
 */
export interface RecipeStoreScenarioBundle {
  scenario: Scenario;
  getRunStats(): RecipeRunStats[];
}

/**
 * Builds a single `Scenario` whose only step picks a verified recipe
 * from the store and replays it. Designed to be passed to
 * `scenarioLoad({ scenarios: [{ scenario, workers }] })`.
 */
export function recipeStoreScenario(opts: RecipeStoreScenarioOptions): Scenario {
  return recipeStoreScenarioWithStats(opts).scenario;
}

/**
 * Same as `recipeStoreScenario` but also exposes a `getRunStats()`
 * accessor that returns per-recipe firing counts accumulated over
 * the bundle's lifetime. Pair with `scenarioLoad` directly when you
 * need stats; `scenarioLoadFromStore` does the wiring for you.
 */
export function recipeStoreScenarioWithStats(
  opts: RecipeStoreScenarioOptions,
): RecipeStoreScenarioBundle {
  const chain = opts.chainRequires !== false;
  const selection = opts.selection ?? "uniform";
  const name = opts.scenarioName ?? "recipe-mix";

  // Per-worker memo: track which recipes already ran on this Page so
  // `requires` chains dedupe across iterations within the same worker.
  // (scenarioLoad gives each worker its own BrowserContext, so the
  // page object is stable for the worker's lifetime.)
  const workerMemo = new WeakMap<ScenarioContext["page"], Set<string>>();
  // Per-bundle firing log for issue #92 observability.
  const firings: Array<{
    name: string;
    succeeded: boolean;
    durationMs: number;
    timestamp: number;
  }> = [];

  const scenario = defineScenario({
    name,
    thinkTime: opts.thinkTime,
    steps: [
      {
        name: "pick-and-replay",
        run: async (ctx) => {
          // Read each iteration, so a recipe whose status a recorded replay
          // changed (`record`) stops being picked. When none is left the run
          // stops: failing every iteration until the deadline would only
          // bury the reason.
          const candidates = candidatesOf(opts);
          if (candidates.length === 0) {
            const reason = `${name}: ${noCandidates(opts, true)}`;
            ctx.stopRun?.(reason);
            throw new Error(reason);
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

          // Every replay goes to the load run's base URL: a recipe keeps
          // the origin it was recorded on, and a load test of staging
          // that quietly hit localhost would report localhost's numbers.
          const baseUrl = ctx.baseUrl;
          if (chain && recipe.requires.filter((d) => !d.startsWith("__")).length > 0) {
            const result = await runRecipeWithRequires({
              page: ctx.page,
              recipe,
              store: opts.store,
              alreadyRan: memo,
              vars,
              baseUrl,
              // With `record`, stats go in for each link in the chain so
              // the store reflects every replay — mirrors recipeDriver.
              onProgress: (ev) => {
                if (ev.kind !== "complete") return;
                if (opts.record) {
                  if (ev.result.ok) opts.store.recordSuccess(ev.recipe, ev.result.durationMs);
                  else opts.store.recordFailure(ev.recipe);
                }
                firings.push({
                  name: ev.recipe,
                  succeeded: ev.result.ok,
                  durationMs: ev.result.durationMs,
                  timestamp: Date.now(),
                });
              },
            });
            if (!result.ok) {
              throw new Error(
                `${name}: chain failed at ${result.failedAt} — ${result.results[result.failedAt!]?.failedAt?.reason ?? "unknown"}`,
              );
            }
            return;
          }
          const result = await runRecipe(ctx.page, recipe, { vars, baseUrl });
          if (result.ok) {
            if (opts.record) opts.store.recordSuccess(recipe.name, result.durationMs);
            firings.push({
              name: recipe.name,
              succeeded: true,
              durationMs: result.durationMs,
              timestamp: Date.now(),
            });
          } else {
            if (opts.record) opts.store.recordFailure(recipe.name);
            firings.push({
              name: recipe.name,
              succeeded: false,
              durationMs: result.durationMs,
              timestamp: Date.now(),
            });
            throw new Error(
              `${name}: recipe ${recipe.name} failed at step ${result.failedAt?.index} — ${result.failedAt?.reason ?? "unknown"}`,
            );
          }
        },
      },
    ],
  });

  return {
    scenario,
    getRunStats: () => aggregateFirings(firings),
  };
}

export interface ScenarioLoadFromStoreOptions extends RecipeStoreScenarioOptions {
  /**
   * The site the run hits. Each recipe replays on this origin, whatever
   * origin it was recorded on (`rebaseRecipe`).
   */
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
  stopOnUnreachable?: ScenarioLoadOptions["stopOnUnreachable"];
  viewport?: ScenarioLoadOptions["viewport"];
  storageState?: string | ((workerIndex: number) => string | undefined);
}

export interface ScenarioLoadFromStoreResult extends ScenarioLoadResult {
  /** Per-recipe firing counts for the run (issue #92). */
  recipes: RecipeRunStats[];
}

/**
 * Top-level convenience: builds the scenario from the store and runs
 * `scenarioLoad` with the given concurrency / duration. Returns the
 * usual `ScenarioLoadResult` — chaos / SLO / timeline / fault stats
 * all work as normal — plus a per-recipe firing summary (issue #92).
 *
 * Throws, before launching a browser, when no recipe is eligible.
 */
export async function scenarioLoadFromStore(
  opts: ScenarioLoadFromStoreOptions,
): Promise<ScenarioLoadFromStoreResult> {
  if (candidatesOf(opts).length === 0) {
    throw new Error(`scenarioLoadFromStore: ${noCandidates(opts)}`);
  }
  const bundle = recipeStoreScenarioWithStats(opts);
  const result = await scenarioLoad({
    baseUrl: opts.baseUrl,
    duration: opts.duration,
    rampUp: opts.rampUp,
    scenarios: [
      {
        scenario: bundle.scenario,
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
    stopOnUnreachable: opts.stopOnUnreachable,
    viewport: opts.viewport,
  });
  return { ...result, recipes: bundle.getRunStats() };
}

/**
 * Every recipe a store scenario built from `opts` can replay: the
 * candidates it picks from and, with `chainRequires` on, what their
 * `requires` chains run first. A chain that does not resolve is left to
 * fail in the run, where it is reported.
 */
export function storeScenarioRecipes(
  opts: Pick<RecipeStoreScenarioOptions, "store" | "status" | "filter" | "chainRequires">,
): ActionRecipe[] {
  const out = new Map<string, ActionRecipe>();
  for (const recipe of candidatesOf(opts)) {
    let chain = [recipe];
    if (opts.chainRequires !== false) {
      try {
        chain = resolveDependencies(recipe, opts.store);
      } catch {}
    }
    for (const r of chain) out.set(r.name, r);
  }
  return [...out.values()];
}

// -------- internals --------

type CandidateOptions = Pick<RecipeStoreScenarioOptions, "store" | "status" | "filter">;

function candidatesOf(opts: CandidateOptions): ActionRecipe[] {
  const status = opts.status ?? "verified";
  const filter = opts.filter ?? (() => true);
  return opts.store.list().filter((r) => r.status === status && filter(r));
}

/** Why there is nothing to replay; `midRun` when there was at the start. */
function noCandidates(opts: CandidateOptions, midRun = false): string {
  const what = `${opts.status ?? "verified"} recipes ${opts.filter ? "match the filter" : "in the store"}`;
  return midRun ? `no ${what} any more — nothing left to replay` : `no ${what} — nothing to replay`;
}

function pickRecipe(
  candidates: ReadonlyArray<ActionRecipe>,
  strategy: RecipeSelection,
  ctx: SelectionContext,
): ActionRecipe {
  if (typeof strategy === "function") return strategy(candidates, ctx);
  // scenarioLoad is non-deterministic by design — see scenario-load.ts's
  // per-run seed comment. So we wrap Math.random in the Rng shape rather
  // than threading the driver-layer Rng through.
  const rng: Rng = { next: Math.random, seed: 0 };
  if (strategy === "uniform") {
    return weightedPick(candidates, () => 1, rng);
  }
  // strategy === "by-success-rate":
  // Weight each candidate by (successes + 1) / (total + 1) so a
  // brand-new candidate gets ~uniform weight, while a long-tested
  // reliable one wins more often. Capped to [0.1, 1] so a single
  // 99%-reliable recipe doesn't crowd out everything else.
  return weightedPick(
    candidates,
    (r) => {
      const total = r.stats.successCount + r.stats.failCount;
      const rate = (r.stats.successCount + 1) / (total + 1);
      return Math.max(0.1, Math.min(1, rate));
    },
    rng,
  );
}

function resolveVars(
  vars: RecipeStoreScenarioOptions["vars"],
  ctx: SelectionContext,
): RecipeVars | undefined {
  if (!vars) return undefined;
  if (typeof vars === "function") return vars(ctx);
  return vars;
}
