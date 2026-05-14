/**
 * Template substitution for parametrised recipe steps.
 *
 * Grammar: `{{name}}` is replaced with `vars[name]`. Names are
 * alphanumeric + underscore + dot (so `{{user.email}}` works). A
 * missing variable throws — silent substitution to an empty string
 * would let a typo silently bypass a fill.
 *
 * Substituted positions, per step kind:
 *   - `navigate.url`
 *   - `fill.value`
 *   - `select.value`
 *
 * NOT substituted: selectors, keys, timeouts. Selectors and keys
 * are stable references that shouldn't vary per-iteration — if you
 * need a per-iteration selector, that's a sign the recipe needs
 * branching, not templating.
 *
 * Use cases:
 *   - Data-driven signup recipes (100 unique emails)
 *   - Per-worker login (each worker uses different test credentials)
 *   - Run the same checkout flow against multiple product IDs
 */
import type { RecipeStep } from "./types.js";

export type RecipeVars = Record<string, string | number | boolean>;

const TEMPLATE_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g;

export function substituteString(template: string, vars: RecipeVars): string {
  return template.replace(TEMPLATE_RE, (_match, name: string) => {
    if (!(name in vars)) {
      throw new Error(
        `template substitution: variable "${name}" is not defined (referenced in ${JSON.stringify(template)})`,
      );
    }
    return String(vars[name]);
  });
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
