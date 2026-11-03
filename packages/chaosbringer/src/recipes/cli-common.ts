/**
 * Shared between `recipes/cli.ts` and `recipes/load-cli.ts`. The two
 * CLI surfaces accept the same `--dir / --global / --json / --quiet`
 * flags and open the store the same way; keeping that in one place
 * means a future flag (e.g. `--cache`) updates both surfaces.
 */
import { UsageError } from "../cli-usage.js";
import { readInputJson } from "../input-files.js";
import { rebaseNotice } from "./replay.js";
import { RecipeStore } from "./store.js";
import { type RecipeVars, recipeVariables, VARIABLE_NAME_RE } from "./templating.js";
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
 * `raw` as an integer >= `min`, or undefined when the flag was not given. A
 * value that is not one is a `UsageError` naming the flag: `Number()` alone
 * read `--keep-last abc` as NaN and `--to-version` left out as 0.
 */
export function intFlag(flag: string, raw: string | undefined, min: number): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(n) || n < min) {
    throw new UsageError(`${flag} must be an integer >= ${min}, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/**
 * A `UsageError` (exit 2) unless `--base-url` is an absolute http(s) URL:
 * replay moves a recipe's URLs onto its origin (`rebaseRecipe`), and a
 * value with no origin would fail every replay instead of the command.
 */
export function requireBaseUrl(url: string): void {
  let ok = false;
  try {
    const { protocol } = new URL(url);
    ok = protocol === "http:" || protocol === "https:";
  } catch {}
  if (!ok) throw new UsageError(`--base-url must be an absolute http(s) URL, got ${JSON.stringify(url)}`);
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

/**
 * `--var name=value` (repeatable) and `--vars-file <json>`: the values of a
 * recipe's `{{name}}` placeholders, for the commands that replay recipes
 * (`recipes verify`, `recipes repair`, `load`).
 */
export const VAR_OPTIONS = {
  var: { type: "string" as const, multiple: true as const },
  "vars-file": { type: "string" as const },
};

/** The `--help` lines for `VAR_OPTIONS`, indented by `indent` and its option column `width` wide. */
export function varsHelp(indent = "  ", width = 22): string {
  return [
    `${"--var NAME=VALUE".padEnd(width)}  value of a recipe's {{NAME}} placeholder (repeatable;`,
    `${" ".repeat(width)}  wins over --vars-file)`,
    `${"--vars-file FILE".padEnd(width)}  a JSON object of NAME: string | number | boolean,`,
    `${" ".repeat(width)}  e.g. the file \`drive --save-secrets\` writes`,
  ]
    .map((l) => indent + l)
    .join("\n");
}

/**
 * The vars `--vars-file` and then `--var` give (a `--var` wins over the
 * file), `{}` with neither. Each refusal is a `UsageError` naming the flag:
 * a `--var` with no `=` or a name a placeholder cannot use, a file that is
 * missing or not JSON (`readInputJson`), or one that is not an object of
 * strings, numbers and booleans. A number or boolean is kept as it is and
 * written as `String(value)` where it is substituted (`5`, `true`).
 */
export function parseVarFlags(values: { var?: string[]; "vars-file"?: string }): RecipeVars {
  const vars: RecipeVars = {};
  const file = values["vars-file"];
  if (file !== undefined) {
    const raw = readInputJson("--vars-file", file, "vars");
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new UsageError(`--vars-file ${file}: expected a JSON object of variable names to values`);
    }
    for (const [name, value] of Object.entries(raw)) {
      if (!VARIABLE_NAME_RE.test(name)) {
        throw new UsageError(`--vars-file ${file}: ${JSON.stringify(name)} is not a variable name (${NAME_RULE})`);
      }
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new UsageError(
          `--vars-file ${file}: ${JSON.stringify(name)} must be a string, number or boolean, got ${value === null ? "null" : Array.isArray(value) ? "an array" : typeof value}`,
        );
      }
      vars[name] = value;
    }
  }
  for (const pair of values.var ?? []) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new UsageError(`--var ${JSON.stringify(pair)}: expected NAME=VALUE`);
    const name = pair.slice(0, eq);
    if (!VARIABLE_NAME_RE.test(name)) {
      throw new UsageError(`--var ${JSON.stringify(pair)}: ${JSON.stringify(name)} is not a variable name (${NAME_RULE})`);
    }
    vars[name] = pair.slice(eq + 1);
  }
  return vars;
}

const NAME_RULE = "letters, digits, _ . -, starting with a letter or _";

/**
 * A `UsageError` (exit 2, before a browser starts) for the first recipe
 * that uses a `{{name}}` placeholder `vars` does not define: each replay of
 * it would fail on that variable, and record the failure against a recipe
 * that is not broken. Only the placeholders a replay fills in count: its
 * steps' and postconditions'. These commands do not read preconditions
 * (`recipeDriver` does, to match a page), so one used only there is not
 * asked for.
 */
export function requireVars(recipes: Iterable<ActionRecipe>, vars: RecipeVars): void {
  for (const recipe of recipes) {
    const missing = recipeVariables({ ...recipe, preconditions: [] }).filter((name) => !Object.hasOwn(vars, name));
    if (missing.length === 0) continue;
    const names = missing.map((n) => `"${n}"`).join(", ");
    throw new UsageError(
      `${recipe.name}: variable${missing.length > 1 ? "s" : ""} ${names} ${missing.length > 1 ? "are" : "is"} not defined ` +
        `(pass ${missing.map((n) => `--var ${n}=VALUE`).join(" ")}, or --vars-file FILE)`,
    );
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
