/**
 * Stall-triggered advisor driver — the new layering of the original
 * `consultAdvisorIfStalled` policy. Wraps a primary (usually cheap)
 * driver and only consults the secondary (usually `aiDriver`) when a
 * stall signal fires:
 *   - N consecutive zero-novelty actions (`noveltyStall`)
 *   - an invariant violation since the last action
 *   - an explicit `consultNow()` request from caller code
 *
 * This re-creates the legacy advisor behaviour on top of the new Driver
 * interface without coupling the crawler to advisor-specific runtime
 * state. The primary driver still runs every step; the secondary only
 * preempts when the policy permits.
 */
import type { ActionResult } from "../types.js";
import type { Driver, DriverPick, DriverStep } from "./types.js";

export interface AdvisorFallbackOptions {
  primary: Driver;
  /** Driver consulted only when the stall policy fires (typically aiDriver). */
  fallback: Driver;
  /** Consecutive zero-novelty actions before consulting fallback. Default: 5. */
  noveltyStallThreshold?: number;
  /** Consult on invariant violations. Default: true. */
  consultOnInvariantViolation?: boolean;
  /** Optional name override. */
  name?: string;
}

export interface NoveltySignal {
  /** Call after each action to report whether it produced new coverage. */
  recordNovelty(hadNovelty: boolean): void;
  /** Force the next step to consult the fallback. */
  consultNow(): void;
}

/**
 * Returns a driver and a control object the caller can use to feed
 * novelty / invariant signals back in. The crawler already tracks these
 * for the legacy advisor — wiring them here keeps the same source of
 * truth.
 */
export function advisorFallbackDriver(
  options: AdvisorFallbackOptions,
): { driver: Driver; signal: NoveltySignal } {
  const threshold = options.noveltyStallThreshold ?? 5;
  const consultOnInvariant = options.consultOnInvariantViolation ?? true;

  let zeroNoveltyStreak = 0;
  let forceNext = false;

  function shouldConsult(step: DriverStep): boolean {
    if (forceNext) return true;
    if (zeroNoveltyStreak >= threshold) return true;
    if (consultOnInvariant && step.invariantViolations.length > 0) return true;
    return false;
  }

  const driver: Driver = {
    name: options.name ?? `advisor-fallback(${options.primary.name},${options.fallback.name})`,
    async selectAction(step: DriverStep): Promise<DriverPick | null> {
      if (shouldConsult(step)) {
        const pick = await options.fallback.selectAction(step);
        if (pick !== null) {
          // Reset stall counters once the fallback successfully fires so
          // we don't burn budget consulting again on the next step.
          zeroNoveltyStreak = 0;
          forceNext = false;
          return pick;
        }
        // Fallback declined (budget, soft fail). Fall through to primary so
        // the loop still makes progress.
      }
      return options.primary.selectAction(step);
    },
    onActionComplete(action: ActionResult, step: DriverStep) {
      options.primary.onActionComplete?.(action, step);
      options.fallback.onActionComplete?.(action, step);
    },
    onPageStart(url: string) {
      zeroNoveltyStreak = 0;
      forceNext = false;
      options.primary.onPageStart?.(url);
      options.fallback.onPageStart?.(url);
    },
    onPageEnd(url: string) {
      options.primary.onPageEnd?.(url);
      options.fallback.onPageEnd?.(url);
    },
  };

  const signal: NoveltySignal = {
    recordNovelty(hadNovelty: boolean) {
      zeroNoveltyStreak = hadNovelty ? 0 : zeroNoveltyStreak + 1;
    },
    consultNow() {
      forceNext = true;
    },
  };

  return { driver, signal };
}
