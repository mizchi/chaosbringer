/**
 * Pure trigger policy for the action advisor. Decides whether the crawler
 * should consult the advisor on a given step, based on stall counters,
 * pending invariant violations, and budget caps. No I/O, no provider
 * coupling — kept pure so the policy can be unit-tested without mocking
 * the crawler or the model.
 *
 * See `docs/superpowers/specs/2026-05-01-vlm-action-advisor-design.md` §4
 * for the design rationale.
 */

export interface TriggerPolicy {
  maxCallsPerCrawl: number;
  maxCallsPerPage: number;
  noveltyStallThreshold: number;
  consultOnInvariantViolation: boolean;
  minCandidatesToConsult: number;
}

export interface TriggerState {
  callsThisCrawl: number;
  callsThisPage: number;
  consecutiveZeroNovelty: number;
  pendingInvariantViolation: boolean;
}

export type TriggerReason = "novelty_stall" | "invariant_violation" | "explicit_request";

export type TriggerSkipReason =
  | "budget_crawl"
  | "budget_page"
  | "few_candidates"
  | "not_stalled";

export interface TriggerDecision {
  consult: boolean;
  reason?: TriggerReason;
  skipReason?: TriggerSkipReason;
}

export function defaultTriggerPolicy(): TriggerPolicy {
  return {
    maxCallsPerCrawl: 20,
    maxCallsPerPage: 3,
    noveltyStallThreshold: 5,
    consultOnInvariantViolation: true,
    minCandidatesToConsult: 3,
  };
}

export function decideTrigger(
  state: TriggerState,
  policy: TriggerPolicy,
  candidateCount: number,
): TriggerDecision {
  if (state.callsThisCrawl >= policy.maxCallsPerCrawl) {
    return { consult: false, skipReason: "budget_crawl" };
  }
  if (state.callsThisPage >= policy.maxCallsPerPage) {
    return { consult: false, skipReason: "budget_page" };
  }
  if (candidateCount < policy.minCandidatesToConsult) {
    return { consult: false, skipReason: "few_candidates" };
  }

  if (policy.consultOnInvariantViolation && state.pendingInvariantViolation) {
    return { consult: true, reason: "invariant_violation" };
  }
  if (state.consecutiveZeroNovelty >= policy.noveltyStallThreshold) {
    return { consult: true, reason: "novelty_stall" };
  }
  return { consult: false, skipReason: "not_stalled" };
}
