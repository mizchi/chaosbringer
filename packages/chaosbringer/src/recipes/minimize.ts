/**
 * Delta-debugging for AI-captured reproduction traces.
 *
 * The AI driver typically wanders before stumbling into the bug. A
 * 15-step trace might have a 3-step minimal reproducer hiding inside.
 * `minimizeRecipeTrace` greedily removes one step at a time and replays the
 * remainder; whenever the goal still fires, the shorter sequence
 * becomes the new working trace.
 *
 * Algorithm: 1-minimal delta debugging.
 *   - Worst case: O(N^2) replays for an N-step trace
 *   - Always converges (length is strictly monotonically decreasing)
 *   - Produces a "1-minimal" sequence: removing ANY step would fail
 *     reproduction. Not necessarily globally minimal — pairs of
 *     mutually-required steps survive — but cheap and effective for
 *     typical N ≤ 20.
 *
 * The replay loop uses the caller's `setupPage` factory exactly the
 * same way `verifyAndPromote` does. We do not own browser lifecycle —
 * that's the caller's concern.
 */
import type { Page } from "playwright";
import { runRecipe } from "./replay.js";
import type {
  ActionRecipe,
  ActionTrace,
  Goal,
  GoalContext,
  RecipeStep,
} from "./types.js";
import { emptyStats } from "./types.js";

export interface MinimizeRecipeOptions {
  /** Trace whose `steps` we want to shrink. Must be `successful: true`. */
  trace: ActionTrace;
  /** Same Goal that the trace satisfied. Polled after each replay. */
  goal: Goal;
  /**
   * Fresh-page factory. Each replay needs a clean context so prior
   * steps' side effects don't pollute the new run. The factory
   * returns a page already navigated to the trace's start URL.
   */
  setupPage: () => Promise<{ page: Page; cleanup: () => Promise<void> }>;
  /** Hard cap on replays. Default: `steps.length ** 2`. */
  maxReplays?: number;
  /**
   * Caller-supplied success check. Defaults to `goal.successCheck`,
   * but tests can override to skip the page hit. The default needs a
   * real `Page` (because Goals can read the DOM); test-only overrides
   * can synthesise their own.
   */
  successCheck?: (ctx: GoalContext) => Promise<boolean>;
  verbose?: boolean;
}

export interface MinimizeRecipeResult {
  /** Resulting 1-minimal step sequence. */
  steps: RecipeStep[];
  originalLength: number;
  minimizedLength: number;
  replays: number;
  /** True when at least one step was removed. */
  shrank: boolean;
  /**
   * Why we stopped: "converged" when no further reduction is
   * possible; "budget" when `maxReplays` was reached first.
   */
  reason: "converged" | "budget";
}

export async function minimizeRecipeTrace(opts: MinimizeRecipeOptions): Promise<MinimizeRecipeResult> {
  if (!opts.trace.successful) {
    throw new Error("minimizeRecipeTrace: refusing to minimise an unsuccessful trace");
  }
  const log = opts.verbose ? (m: string) => console.log(`[minimize] ${m}`) : () => {};
  const original = opts.trace.steps;
  let current = [...original];
  const maxReplays = opts.maxReplays ?? original.length * original.length;
  let replays = 0;
  let reason: "converged" | "budget" = "converged";

  // Greedy: keep scanning until a full pass finds nothing to remove.
  let changed = true;
  outer: while (changed && current.length > 0) {
    changed = false;
    for (let i = 0; i < current.length; i++) {
      if (replays >= maxReplays) {
        reason = "budget";
        log(`hit budget at ${replays} replays`);
        break outer;
      }
      const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
      replays += 1;
      log(`replay ${replays}: try without step ${i} (${current[i]!.kind}) — ${current.length} → ${candidate.length}`);
      const stillReproduces = await tryReproduce(candidate, opts);
      if (stillReproduces) {
        current = candidate;
        changed = true;
        log(`  step ${i} removed`);
        break; // restart the scan from index 0
      }
    }
  }

  return {
    steps: current,
    originalLength: original.length,
    minimizedLength: current.length,
    replays,
    shrank: current.length < original.length,
    reason,
  };
}

async function tryReproduce(
  candidateSteps: ReadonlyArray<RecipeStep>,
  opts: MinimizeRecipeOptions,
): Promise<boolean> {
  if (candidateSteps.length === 0) {
    // Empty step list — caller's `setupPage` already navigated to
    // the failure URL, so reproduction depends solely on whether the
    // goal fires on initial load.
    const { page, cleanup } = await opts.setupPage();
    try {
      return await goalFires(page, opts);
    } finally {
      await cleanup().catch(() => {});
    }
  }

  const { page, cleanup } = await opts.setupPage();
  try {
    // Build a one-shot recipe out of the candidate steps and replay.
    // We don't carry preconditions / postconditions — the trace's
    // Goal is the assertion.
    const ephemeral: ActionRecipe = {
      name: "__minimize-candidate",
      description: "",
      preconditions: [],
      steps: candidateSteps as RecipeStep[],
      postconditions: [],
      requires: [],
      stats: emptyStats(),
      origin: "ai-extracted",
      status: "candidate",
      version: 1,
      createdAt: 0,
      updatedAt: 0,
    };
    const result = await runRecipe(page, ephemeral);
    if (!result.ok) return false;
    return await goalFires(page, opts);
  } finally {
    await cleanup().catch(() => {});
  }
}

async function goalFires(page: Page, opts: MinimizeRecipeOptions): Promise<boolean> {
  const check = opts.successCheck ?? opts.goal.successCheck;
  return check({
    page,
    url: page.url(),
    history: [],
    errors: [],
  }).catch(() => false);
}
