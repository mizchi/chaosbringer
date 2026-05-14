/**
 * Auto-verification: run a candidate recipe K times under a clean
 * setup, decide promote / keep-candidate / demote based on the
 * success ratio.
 *
 * The caller provides a `setupPage` factory — typically wrapping
 * `browser.newContext().newPage()` plus `goto(startUrl)` — because
 * verification semantics differ across consumers. A crawler verifier
 * wants a fresh context every run; a Playwright Test verifier wants
 * to reuse a logged-in storage state. We don't impose either.
 *
 * Stats are recorded back into the store after every run, regardless
 * of the eventual promotion outcome.
 */
import type { Page } from "playwright";
import { runRecipe } from "./replay.js";
import type { RecipeStore } from "./store.js";
import type { ActionRecipe } from "./types.js";

export interface VerifyOptions {
  /** How many times to re-run before deciding. */
  runs?: number;
  /** Promote if success / runs >= this. */
  minSuccessRate?: number;
  /** Demote (mark "demoted") if success / runs < this. */
  demoteBelow?: number;
  /**
   * Factory that produces a Page ready to start the recipe at its
   * starting URL. The factory's return tuple also gives a `cleanup`
   * hook so the verifier can dispose contexts deterministically.
   */
  setupPage: () => Promise<{ page: Page; cleanup: () => Promise<void> }>;
  /** Logger for visibility — defaults to `console.log` if `verbose`, else silent. */
  verbose?: boolean;
}

export interface VerifyResult {
  promoted: boolean;
  demoted: boolean;
  successRate: number;
  runs: number;
  /** Per-run outcomes for debugging. */
  outcomes: Array<{ ok: boolean; durationMs: number; reason?: string }>;
}

export async function verifyAndPromote(
  store: RecipeStore,
  recipe: ActionRecipe,
  opts: VerifyOptions,
): Promise<VerifyResult> {
  const runs = opts.runs ?? 5;
  const minSuccessRate = opts.minSuccessRate ?? 0.8;
  const demoteBelow = opts.demoteBelow ?? 0.4;
  const log = opts.verbose ? (msg: string) => console.log(`[verify ${recipe.name}] ${msg}`) : () => {};

  const outcomes: VerifyResult["outcomes"] = [];
  let successes = 0;

  for (let i = 0; i < runs; i++) {
    const { page, cleanup } = await opts.setupPage();
    try {
      const result = await runRecipe(page, recipe);
      outcomes.push({
        ok: result.ok,
        durationMs: result.durationMs,
        reason: result.failedAt?.reason,
      });
      if (result.ok) {
        successes += 1;
        store.recordSuccess(recipe.name, result.durationMs);
        log(`run ${i + 1}/${runs}: ok (${result.durationMs.toFixed(0)}ms)`);
      } else {
        store.recordFailure(recipe.name);
        log(`run ${i + 1}/${runs}: FAIL at step ${result.failedAt?.index} — ${result.failedAt?.reason}`);
      }
    } finally {
      await cleanup().catch(() => {});
    }
  }

  const successRate = successes / runs;
  let promoted = false;
  let demoted = false;

  if (successRate >= minSuccessRate) {
    store.setStatus(recipe.name, "verified");
    promoted = true;
    log(`promoted (rate=${successRate.toFixed(2)})`);
  } else if (successRate < demoteBelow) {
    store.setStatus(recipe.name, "demoted");
    demoted = true;
    log(`demoted (rate=${successRate.toFixed(2)})`);
  } else {
    // Stays in current status — typically `candidate`.
    log(`undecided (rate=${successRate.toFixed(2)})`);
  }

  return { promoted, demoted, successRate, runs, outcomes };
}
