/**
 * Static linter for `ActionRecipe` JSON. Catches the brittleness
 * classes we kept rediscovering at review time:
 *
 *   - click/fill steps without `expectAfter` (silent progress through
 *     a broken UI)
 *   - `click-at` without `viewportHint` (coordinate clicks degrade
 *     across screen sizes — at least require a hint so replay can
 *     detect mismatch)
 *   - empty `preconditions` (recipe is eligible everywhere, including
 *     the wrong app)
 *   - verified recipes with no `postconditions` (verification can
 *     never fail correctly without an end-state assertion)
 *   - excessive raw `wait.ms` (sleep is a smell; prefer `waitFor`)
 *   - adjacent duplicate `wait`s (left over from naive trace capture)
 *   - empty `steps`
 *   - `requires` pointing at recipes not in the store (cross-recipe
 *     dangling reference)
 *
 * The linter is intentionally NOT a runtime check — it operates on
 * the JSON only. Pass an optional `RecipeStore` to enable cross-recipe
 * lints (missing `requires`, cycle detection).
 *
 * Severity is advisory: callers decide whether warnings should fail
 * a CI step. The CLI's `--strict` flag promotes warnings to failures.
 */
import { resolveDependencies } from "./composition.js";
import type { RecipeStore } from "./store.js";
import type { ActionRecipe, RecipeStep } from "./types.js";

export type LintSeverity = "error" | "warn" | "info";

export interface LintIssue {
  recipe: string;
  severity: LintSeverity;
  /** Short identifier — stable across versions for scripting. */
  rule: LintRule;
  /** Human-readable message. */
  message: string;
  /** Step index (0-based) when the lint targets a specific step. */
  stepIndex?: number;
}

export type LintRule =
  | "empty-steps"
  | "missing-expect-after"
  | "click-at-without-viewport-hint"
  | "empty-preconditions"
  | "verified-without-postconditions"
  | "long-raw-wait"
  | "adjacent-duplicate-wait"
  | "missing-required-recipe"
  | "requires-cycle"
  | "hardcoded-credentials";

export interface LintOptions {
  /**
   * When provided, enables cross-recipe lints (missing `requires`,
   * cycle detection). Pass the store you'd resolve the chain against.
   */
  store?: RecipeStore;
  /**
   * Pre-computed set of names known to the store. Pass when linting a
   * batch (`lintStore`) to avoid re-listing the store inside every
   * recipe — `store.list()` deep-clones every entry, so without this
   * the cost is O(N²) deep-clones.
   */
  knownNames?: ReadonlySet<string>;
  /**
   * Wait threshold (ms) above which raw `wait` steps emit a `long-raw-wait`.
   * Default: 2000ms.
   */
  longWaitThresholdMs?: number;
}

export interface LintReport {
  readonly issues: ReadonlyArray<LintIssue>;
  readonly errorCount: number;
  readonly warnCount: number;
  readonly infoCount: number;
}

const DEFAULT_LONG_WAIT_MS = 2000;

export function lintRecipe(recipe: ActionRecipe, opts: LintOptions = {}): LintIssue[] {
  const out: LintIssue[] = [];
  const longWait = opts.longWaitThresholdMs ?? DEFAULT_LONG_WAIT_MS;

  if (recipe.steps.length === 0) {
    out.push({
      recipe: recipe.name,
      severity: "error",
      rule: "empty-steps",
      message: "recipe has no steps — replay is a no-op",
    });
  }
  if (recipe.preconditions.length === 0) {
    out.push({
      recipe: recipe.name,
      severity: "warn",
      rule: "empty-preconditions",
      message:
        "recipe has no preconditions — it is eligible on every page, including the wrong app",
    });
  }
  if (recipe.status === "verified" && recipe.postconditions.length === 0) {
    out.push({
      recipe: recipe.name,
      severity: "error",
      rule: "verified-without-postconditions",
      message:
        "verified recipe has no postconditions — verification cannot fail correctly",
    });
  }

  recipe.steps.forEach((step, i) => {
    if (needsExpectAfter(step) && !hasExpectAfter(step)) {
      out.push({
        recipe: recipe.name,
        severity: "warn",
        rule: "missing-expect-after",
        message: `${step.kind} step has no expectAfter — broken UIs will be missed`,
        stepIndex: i,
      });
    }
    if (step.kind === "click-at" && !step.viewportHint) {
      out.push({
        recipe: recipe.name,
        severity: "error",
        rule: "click-at-without-viewport-hint",
        message:
          "click-at without viewportHint — coordinates can't be validated against the replay viewport",
        stepIndex: i,
      });
    }
    if (step.kind === "wait" && step.ms >= longWait) {
      out.push({
        recipe: recipe.name,
        severity: "warn",
        rule: "long-raw-wait",
        message: `raw wait of ${step.ms}ms is brittle — prefer waitFor with a selector`,
        stepIndex: i,
      });
    }
    if (i > 0) {
      const prev = recipe.steps[i - 1]!;
      if (prev.kind === "wait" && step.kind === "wait") {
        out.push({
          recipe: recipe.name,
          severity: "info",
          rule: "adjacent-duplicate-wait",
          message: "adjacent wait steps can be merged",
          stepIndex: i,
        });
      }
    }
    if (looksLikeRawCredential(step)) {
      out.push({
        recipe: recipe.name,
        severity: "warn",
        rule: "hardcoded-credentials",
        message:
          "fill step looks like a credential field but the value is not templated — consider {{password}} + vars",
        stepIndex: i,
      });
    }
  });

  if (opts.store) {
    const known = opts.knownNames ?? new Set(opts.store.list().map((r) => r.name));
    for (const dep of recipe.requires) {
      // Sentinel markers (`__repaired-from-vN`, `__rolled-back-from-vN`)
      // are bookkeeping, not real requires — skip them.
      if (dep.startsWith("__")) continue;
      if (!known.has(dep)) {
        out.push({
          recipe: recipe.name,
          severity: "error",
          rule: "missing-required-recipe",
          message: `requires "${dep}" which is not in the store`,
        });
      }
    }
    // Only run cycle detection when every dep resolves — otherwise
    // `resolveDependencies` throws on the missing entry first, which
    // we already reported.
    const allResolvable = recipe.requires
      .filter((d) => !d.startsWith("__"))
      .every((d) => known.has(d));
    if (allResolvable && recipe.requires.length > 0) {
      try {
        resolveDependencies(recipe, opts.store);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.toLowerCase().includes("cycle")) {
          out.push({
            recipe: recipe.name,
            severity: "error",
            rule: "requires-cycle",
            message: msg,
          });
        }
      }
    }
  }

  return out;
}

export function lintStore(store: RecipeStore, opts: LintOptions = {}): LintReport {
  const recipes = store.list();
  const knownNames = new Set(recipes.map((r) => r.name));
  const issues: LintIssue[] = [];
  for (const r of recipes) {
    issues.push(...lintRecipe(r, { ...opts, store, knownNames }));
  }
  return summarise(issues);
}

export function summarise(issues: LintIssue[]): LintReport {
  let errorCount = 0;
  let warnCount = 0;
  let infoCount = 0;
  for (const issue of issues) {
    if (issue.severity === "error") errorCount++;
    else if (issue.severity === "warn") warnCount++;
    else infoCount++;
  }
  return { issues, errorCount, warnCount, infoCount };
}

function needsExpectAfter(step: RecipeStep): boolean {
  return (
    step.kind === "click" ||
    step.kind === "click-at" ||
    step.kind === "fill" ||
    step.kind === "select" ||
    step.kind === "press" ||
    step.kind === "navigate"
  );
}

function hasExpectAfter(step: RecipeStep): boolean {
  return "expectAfter" in step && step.expectAfter !== undefined;
}

const CRED_SELECTOR_RX =
  /\b(password|passwd|pwd|secret|token|api[_-]?key|auth)\b/;

function looksLikeRawCredential(step: RecipeStep): boolean {
  if (step.kind !== "fill") return false;
  if (!CRED_SELECTOR_RX.test(step.selector.toLowerCase())) return false;
  // Already templated — caller did the right thing.
  if (step.value.includes("{{")) return false;
  // Empty / "test" values are probably probes, not real credentials.
  if (step.value === "" || /^test/i.test(step.value)) return false;
  return true;
}
