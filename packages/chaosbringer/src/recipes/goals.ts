/**
 * Built-in goals. Each one is a persona × objective × success-check
 * trio you can hand to the AI driver without writing the boilerplate.
 *
 * Custom goals are just plain `Goal` literals — the factories below
 * exist for the common cases.
 */
import type { Goal, GoalContext } from "./types.js";

export interface CompletionGoalOptions {
  /** Free-form task description, fed to the AI as `objective`. */
  task: string;
  /**
   * Returns true when the task is done. Polled between steps.
   * If you only have a URL signal, pass `successCheck: completionByUrl("/thanks")`.
   */
  successCheck: (ctx: GoalContext) => Promise<boolean>;
  budget?: Goal["budget"];
  /** Override the default persona ("typical user"). */
  persona?: string;
}

/**
 * "I'm a normal user, here's what I want to accomplish." Use this for
 * happy-path / smoke flows where deviating from the user goal is
 * itself a failure mode.
 */
export function completionGoal(opts: CompletionGoalOptions): Goal {
  return {
    name: "completion",
    persona: opts.persona ?? "a typical user trying to accomplish a real task",
    objective: opts.task,
    successCheck: opts.successCheck,
    budget: opts.budget ?? { maxSteps: 30, maxBudgetMs: 120_000 },
  };
}

export interface BugHuntingGoalOptions {
  /** Optional hint for what kind of bugs we care about. */
  focus?: string;
  budget?: Goal["budget"];
  /**
   * Custom success check — by default the goal is "found at least one
   * page error since starting". Override when you have a stricter
   * definition (e.g. "found an invariant violation").
   */
  successCheck?: (ctx: GoalContext) => Promise<boolean>;
}

/**
 * "I'm an adversarial tester trying to break this." Pairs naturally
 * with `payloadDriver` / chaos `faultInjection` — the AI explores,
 * the driver injects edge inputs, the goal succeeds the moment an
 * error fires.
 */
export function bugHuntingGoal(opts: BugHuntingGoalOptions = {}): Goal {
  const focus = opts.focus
    ? ` Pay particular attention to: ${opts.focus}.`
    : "";
  return {
    name: "bug-hunting",
    persona: "an adversarial tester trying to expose bugs, edge cases, and broken UI states",
    objective: `Probe the application for failures.${focus} Prefer unusual inputs, rapid clicks, navigation back/forward, and combinations that an ordinary user wouldn't try. Stop when an error is visible.`,
    successCheck: opts.successCheck ?? defaultBugHuntingSuccess,
    budget: opts.budget ?? { maxSteps: 60, maxBudgetMs: 180_000 },
  };
}

const defaultBugHuntingSuccess = async (ctx: GoalContext): Promise<boolean> => {
  return ctx.errors.length > 0;
};

export interface CoverageGoalOptions {
  /** Stop once this many *distinct* selectors have been interacted with. */
  targetSelectors?: number;
  budget?: Goal["budget"];
}

/**
 * "I'm trying to exercise every interactive element." Use this when
 * you have invariants you want to validate across the whole UI and
 * you need an explorer that won't get stuck in one corner.
 */
export function coverageGoal(opts: CoverageGoalOptions = {}): Goal {
  const target = opts.targetSelectors ?? 20;
  return {
    name: "coverage",
    persona: "a systematic exploration agent maximising UI surface coverage",
    objective: `Interact with as many distinct UI elements as possible. Avoid repeating actions on elements you have already tried this run. Aim to touch at least ${target} different interactive elements.`,
    successCheck: makeCoverageSuccess(target),
    budget: opts.budget ?? { maxSteps: target * 2, maxBudgetMs: 300_000 },
  };
}

function makeCoverageSuccess(target: number) {
  const seen = new Set<string>();
  return async (ctx: GoalContext): Promise<boolean> => {
    for (const step of ctx.history) {
      if ("selector" in step && step.selector) seen.add(step.selector);
      if ("url" in step && step.url) seen.add(`__url:${step.url}`);
    }
    return seen.size >= target;
  };
}

/**
 * Convenience success-check: goal achieved when the page URL contains
 * the given substring. The most common shape.
 */
export function completionByUrl(needle: string) {
  return async (ctx: GoalContext) => ctx.url.includes(needle);
}

/**
 * Convenience success-check: goal achieved when a selector is visible.
 */
export function completionBySelector(selector: string) {
  return async (ctx: GoalContext) => {
    return ctx.page
      .locator(selector)
      .first()
      .isVisible()
      .catch(() => false);
  };
}

/**
 * Captured failure handed to `investigateGoal`. The richer the
 * context, the better the AI can reason about reproduction —
 * `errorMessages` and `notes` are surfaced directly inside the
 * persona's prompt.
 */
export interface FailureContext {
  /** Where the failure was observed (used as a navigation start point). */
  url: string;
  /** Short tag used to name the produced regression recipe. */
  signature: string;
  /** Console / page errors observed at the time. */
  errorMessages?: string[];
  /** Steps leading up to the failure, if known. Surfaced as objective context. */
  preceding?: import("./types.js").RecipeStep[];
  /** Free-form additional notes — e.g. "happened under api-500 chaos". */
  notes?: string;
}

export interface InvestigateGoalOptions {
  budget?: Goal["budget"];
  /**
   * Custom check. Defaults to "page URL matches the failure's pathname
   * AND ≥ 1 console error was observed since starting" — i.e. "we're
   * back at the broken page with a fresh error".
   */
  reproducedCheck?: (ctx: GoalContext) => Promise<boolean>;
}

/**
 * "I'm a forensic investigator handed a failure — reproduce it with
 * the smallest action sequence." The Goal's `objective` carries the
 * captured error messages + notes so the AI driver gets enough
 * context to start from the failure URL and re-trigger the same bug.
 */
export function investigateGoal(
  failure: FailureContext,
  opts: InvestigateGoalOptions = {},
): Goal {
  const errs = failure.errorMessages?.length
    ? ` Observed errors: ${failure.errorMessages.slice(0, 5).map(trim).join(" / ")}.`
    : "";
  const notes = failure.notes ? ` Context: ${failure.notes}.` : "";
  const precedingHint = failure.preceding?.length
    ? ` Preceding actions before failure: ${failure.preceding.length} step(s) — use as a hint, not a script.`
    : "";
  return {
    name: "investigate",
    persona:
      "a forensic test engineer trying to reproduce a known failure with the minimum number of actions",
    objective: `A failure was observed at ${failure.url}.${notes}${errs}${precedingHint} Reproduce the failure using as few interactions as possible. Stop the moment the failure is observable again.`,
    successCheck: opts.reproducedCheck ?? defaultReproducedCheck(failure),
    budget: opts.budget ?? { maxSteps: 20, maxBudgetMs: 60_000 },
  };
}

function defaultReproducedCheck(failure: FailureContext) {
  let pathPrefix = "/";
  try {
    pathPrefix = new URL(failure.url).pathname;
  } catch {
    // failure.url might be a relative path; tolerate it.
    pathPrefix = failure.url.startsWith("/") ? failure.url : "/";
  }
  return async (ctx: GoalContext): Promise<boolean> => {
    if (!ctx.url.includes(pathPrefix)) return false;
    return ctx.errors.length > 0;
  };
}

function trim(s: string): string {
  return s.length > 120 ? s.slice(0, 117) + "..." : s;
}

/**
 * Built-in goals as a flat namespace, for ergonomic imports.
 */
export const goals = {
  completion: completionGoal,
  bugHunting: bugHuntingGoal,
  coverage: coverageGoal,
  investigate: investigateGoal,
  byUrl: completionByUrl,
  bySelector: completionBySelector,
};
