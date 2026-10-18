/**
 * Shared between `recipes/cli.ts` and `recipes/load-cli.ts`. The two
 * CLI surfaces accept the same `--dir / --global / --json / --quiet`
 * flags and open the store the same way; keeping that in one place
 * means a future flag (e.g. `--cache`) updates both surfaces.
 */
import { rebaseNotice } from "./replay.js";
import { RecipeStore } from "./store.js";
import type { ActionRecipe, RecipeStatus } from "./types.js";

export interface CommonOpts {
  dir?: string;
  global?: boolean;
  json?: boolean;
  quiet?: boolean;
}

export const COMMON_OPTIONS = {
  dir: { type: "string" as const },
  global: { type: "boolean" as const },
  json: { type: "boolean" as const },
  quiet: { type: "boolean" as const },
  help: { type: "boolean" as const, short: "h" },
};

export function openStore(opts: CommonOpts): RecipeStore {
  if (opts.global) {
    return new RecipeStore({ localDir: false, silent: opts.quiet });
  }
  return new RecipeStore({
    localDir: opts.dir ?? "./chaosbringer-recipes",
    globalDir: false,
    silent: opts.quiet,
  });
}

export const RECIPE_STATUSES = ["candidate", "verified", "demoted"] as const satisfies readonly RecipeStatus[];
export const RECIPE_SELECTIONS = ["uniform", "by-success-rate"] as const;

export function isRecipeStatus(value: string): value is RecipeStatus {
  return (RECIPE_STATUSES as readonly string[]).includes(value);
}

export function isRecipeSelection(
  value: string,
): value is (typeof RECIPE_SELECTIONS)[number] {
  return (RECIPE_SELECTIONS as readonly string[]).includes(value);
}

/**
 * `process.exit(1)` with a message when the recipe isn't in the store.
 * Throws `never`, so TS narrows the caller's `recipe` to `ActionRecipe`.
 */
export function requireRecipe(store: RecipeStore, name: string): ActionRecipe {
  const recipe = store.get(name);
  if (!recipe) {
    console.error(`Recipe not found: ${name}`);
    process.exit(1);
  }
  return recipe;
}

/**
 * `process.exit(2)` unless `--base-url` is an absolute http(s) URL:
 * replay moves a recipe's URLs onto its origin (`rebaseRecipe`), and a
 * value with no origin would fail every replay instead of the command.
 */
export function requireBaseUrl(cmd: string, url: string): void {
  let ok = false;
  try {
    const { protocol } = new URL(url);
    ok = protocol === "http:" || protocol === "https:";
  } catch {}
  if (!ok) {
    console.error(`${cmd}: --base-url must be an absolute http(s) URL, got ${JSON.stringify(url)}`);
    process.exit(2);
  }
}

/**
 * Warn (stderr, so `--json` stays parseable) about each recipe that
 * `baseUrl` moves off the origin it was recorded on: the run is on
 * another host than the recipe says, and the reader should know why.
 */
export function warnRebased(cmd: string, recipes: Iterable<ActionRecipe>, baseUrl: string): void {
  for (const recipe of recipes) {
    const notice = rebaseNotice(recipe, baseUrl);
    if (notice) console.warn(`${cmd}: ${notice}`);
  }
}

export function requireVersion(
  store: RecipeStore,
  name: string,
  version: number,
): ActionRecipe {
  const recipe = store.getVersion(name, version);
  if (!recipe) {
    console.error(`${name}: version ${version} not found`);
    process.exit(1);
  }
  return recipe;
}
