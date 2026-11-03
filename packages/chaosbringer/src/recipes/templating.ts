/**
 * Template substitution for parametrised recipe steps.
 *
 * Grammar: `{{name}}` is replaced with `vars[name]`. Names are
 * alphanumeric + underscore + dot + dash, not starting with a digit or a
 * dash (so `{{user.email}}` works), with optional spaces inside the braces
 * (`{{ name }}`). A number or boolean var is written as `String(value)`.
 *
 * Every replay substitutes, with or without vars: a missing variable is an
 * `UndefinedVariableError` (`runRecipe` returns it as a failed replay, `variable
 * "password" is not defined`). Typing the braces instead, as replay did when
 * it was given no vars, let a recipe that never logged in report ok, and a
 * silent empty string would let a typo bypass a fill.
 *
 * `{{` text that does not fit the grammar (`{{ }}`, `{{7*7}}`, `{x}`) is not
 * a placeholder and is left as written. There is no escape for text that
 * does fit it: to type a literal `{{name}}`, pass the var with that text
 * (`vars: { name: "{{name}}" }`; a substituted value is not read again).
 *
 * Substituted positions, per step kind:
 *   - `navigate.url`
 *   - `fill.value`
 *   - `select.value`
 * and in a precondition or postcondition (`substituteCondition`):
 *   - `urlPattern`, with the value escaped, so it matches literally
 *   - `hasSelector` / `hidesSelector` (`text=Welcome, {{user}}`), as written
 *
 * NOT substituted: step selectors, keys, timeouts. Selectors and keys
 * are stable references that shouldn't vary per-iteration — if you
 * need a per-iteration selector, that's a sign the recipe needs
 * branching, not templating.
 *
 * Use cases:
 *   - Data-driven signup recipes (100 unique emails)
 *   - Per-worker login (each worker uses different test credentials)
 *   - Run the same checkout flow against multiple product IDs
 *   - Credentials kept out of the recipe file (`drive` records a password
 *     field as `{{password}}`; `recipes verify --vars-file` supplies it)
 */
import { escapeRegExp } from "../filters.js";
import type { ActionRecipe, RecipePrecondition, RecipeStep } from "./types.js";

export type RecipeVars = Record<string, string | number | boolean>;

/** A name a `{{name}}` placeholder can use. */
export const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/** A recipe referenced a variable its vars do not define. */
export class UndefinedVariableError extends Error {
  readonly variable: string;
  constructor(variable: string, template: string) {
    super(`template substitution: variable "${variable}" is not defined (referenced in ${JSON.stringify(template)})`);
    this.name = "UndefinedVariableError";
    this.variable = variable;
  }
}

const TEMPLATE_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;

/**
 * `template` with each placeholder replaced by its var, passed through
 * `encode` (`escapeRegExp` for a URL pattern). Throws an
 * `UndefinedVariableError` for a placeholder `vars` has no entry for.
 */
export function substituteString(
  template: string,
  vars: RecipeVars,
  encode: (value: string) => string = (v) => v,
): string {
  return template.replace(TEMPLATE_RE, (_match, name: string) => {
    if (!Object.hasOwn(vars, name)) throw new UndefinedVariableError(name, template);
    return encode(String(vars[name]));
  });
}

/** The names `text`'s placeholders use, in order, each once. */
export function templateNames(text: string): string[] {
  return [...new Set([...text.matchAll(TEMPLATE_RE)].map((m) => m[1]!))];
}

/** True when the string contains at least one `{{var}}` placeholder. */
export function hasTemplates(text: string): boolean {
  // Reset regex state — TEMPLATE_RE is /g and shares state across calls.
  TEMPLATE_RE.lastIndex = 0;
  return TEMPLATE_RE.test(text);
}

/**
 * Return a new `RecipeStep` with all templated fields substituted.
 * Steps with no templated fields are returned by reference (no clone)
 * so per-iteration substitution is cheap when most steps are static.
 */
export function substituteStep(step: RecipeStep, vars: RecipeVars): RecipeStep {
  switch (step.kind) {
    case "navigate":
      return hasTemplates(step.url)
        ? { ...step, url: substituteString(step.url, vars) }
        : step;
    case "fill":
      return hasTemplates(step.value)
        ? { ...step, value: substituteString(step.value, vars) }
        : step;
    case "select":
      return hasTemplates(step.value)
        ? { ...step, value: substituteString(step.value, vars) }
        : step;
    case "click":
    case "click-at":
    case "press":
    case "wait":
    case "waitFor":
      return step;
  }
}

/**
 * A precondition or postcondition with its `urlPattern` and selectors
 * substituted; the same object when none of them has a placeholder. A
 * value in a `urlPattern` is escaped (`escapeRegExp`): `{{page}}` set to
 * `a.b` matches `a.b`, not `axb`.
 */
export function substituteCondition(cond: RecipePrecondition, vars: RecipeVars): RecipePrecondition {
  const urlPattern = cond.urlPattern && hasTemplates(cond.urlPattern) ? substituteString(cond.urlPattern, vars, escapeRegExp) : cond.urlPattern;
  const hasSelector = cond.hasSelector && hasTemplates(cond.hasSelector) ? substituteString(cond.hasSelector, vars) : cond.hasSelector;
  const hidesSelector = cond.hidesSelector && hasTemplates(cond.hidesSelector) ? substituteString(cond.hidesSelector, vars) : cond.hidesSelector;
  if (urlPattern === cond.urlPattern && hasSelector === cond.hasSelector && hidesSelector === cond.hidesSelector) return cond;
  return {
    ...cond,
    ...(urlPattern !== undefined ? { urlPattern } : {}),
    ...(hasSelector !== undefined ? { hasSelector } : {}),
    ...(hidesSelector !== undefined ? { hidesSelector } : {}),
  };
}

/** `substituteCondition` over a list. */
export function substituteConditions(
  conds: ReadonlyArray<RecipePrecondition>,
  vars: RecipeVars,
): RecipePrecondition[] {
  return conds.map((c) => substituteCondition(c, vars));
}

/**
 * Every variable `recipe` references, in its steps and its pre- and
 * postconditions, in order of first use. What a caller must supply to
 * replay it: the CLIs refuse to start without them.
 */
export function recipeVariables(recipe: Pick<ActionRecipe, "steps" | "preconditions" | "postconditions">): string[] {
  const texts: string[] = [];
  for (const s of recipe.steps) {
    if (s.kind === "navigate") texts.push(s.url);
    else if (s.kind === "fill" || s.kind === "select") texts.push(s.value);
  }
  for (const c of [...recipe.preconditions, ...recipe.postconditions]) {
    texts.push(c.urlPattern ?? "", c.hasSelector ?? "", c.hidesSelector ?? "");
  }
  return [...new Set(texts.flatMap(templateNames))];
}

/**
 * Apply substitution to every step in a list. Returns the same array
 * reference when no step had templates (zero-cost no-op for static
 * recipes).
 */
export function substituteSteps(
  steps: ReadonlyArray<RecipeStep>,
  vars: RecipeVars,
): RecipeStep[] | ReadonlyArray<RecipeStep> {
  let changed = false;
  const out: RecipeStep[] = [];
  for (const s of steps) {
    const sub = substituteStep(s, vars);
    if (sub !== s) changed = true;
    out.push(sub);
  }
  return changed ? out : steps;
}
