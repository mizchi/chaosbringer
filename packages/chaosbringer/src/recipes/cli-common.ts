/**
 * Shared between `recipes/cli.ts` and `recipes/load-cli.ts`. The two
 * CLI surfaces accept the same `--dir / --global / --json / --quiet`
 * flags and open the store the same way; keeping that in one place
 * means a future flag (e.g. `--cache`) updates both surfaces.
 */
import { RecipeStore } from "./store.js";
import type { RecipeStatus } from "./types.js";

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
