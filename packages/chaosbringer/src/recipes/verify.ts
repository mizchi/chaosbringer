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
 * Stats are recorded back into the store once the runs are done,
 * regardless of the eventual promotion outcome — unless a run could not
 * connect to the site: a host that is down says nothing about the
 * recipe, so verification stops there and records nothing at all.
 */
import type { Page } from "playwright";
import { unreachableNavigation, watchDocumentRequests } from "../load/unreachable.js";
import { recipeOrigin, runRecipe } from "./replay.js";
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
  /**
   * Site under verification (`RunRecipeOptions.baseUrl`). Without it a
   * recipe that starts with a navigate replays on the host it was
   * recorded on, and a pass there promotes it for a site it never ran on.
   */
  baseUrl?: string;
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
  /**
   * Set when a run could not connect to the site under verification
   * (`baseUrl`, else the origin the recipe was recorded on): the net error,
   * e.g. `net::ERR_CONNECTION_REFUSED at http://localhost:3000/login`.
   * Verification stopped at that run and recorded nothing — no stats, no
   * status change; `promoted` and `demoted` are false.
   */
  unreachable?: string;
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

  const site = opts.baseUrl ?? recipeOrigin(recipe);

  const outcomes: VerifyResult["outcomes"] = [];
  let successes = 0;
  let unreachable: string | null = null;

  for (let i = 0; i < runs && !unreachable; i++) {
    const { page, cleanup } = await opts.setupPage();
    const lastDocument = watchDocumentRequests(page);
    try {
      const result = await runRecipe(page, recipe, { baseUrl: opts.baseUrl });
      outcomes.push({
        ok: result.ok,
        durationMs: result.durationMs,
        reason: result.failedAt?.reason,
      });
      if (result.ok) {
        successes += 1;
        log(`run ${i + 1}/${runs}: ok (${result.durationMs.toFixed(0)}ms)`);
      } else {
        unreachable = site ? unreachableNavigation(result.failedAt?.reason ?? "", site, lastDocument()) : null;
        log(
          unreachable
            ? `run ${i + 1}/${runs}: cannot connect — ${result.failedAt?.reason}`
            : `run ${i + 1}/${runs}: FAIL at step ${result.failedAt?.index} — ${result.failedAt?.reason}`,
        );
      }
    } finally {
      await cleanup().catch(() => {});
    }
  }

  if (unreachable) {
    log(`stopped: ${site} unreachable, nothing recorded`);
    return { promoted: false, demoted: false, successRate: successes / runs, runs, outcomes, unreachable };
  }
  // Only now, so that a verification that stops above leaves the store as
  // it was. The same calls in the same order as one per run.
  for (const o of outcomes) {
    if (o.ok) store.recordSuccess(recipe.name, o.durationMs);
    else store.recordFailure(recipe.name);
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
