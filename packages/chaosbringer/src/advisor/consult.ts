/**
 * Orchestrator that ties trigger policy + budget + provider together.
 * The crawler calls `consultAdvisor` once per chaos action attempt; the
 * policy decides whether to actually invoke the model. Soft failures —
 * provider returning null, throwing, timing out, returning an
 * out-of-range index — all collapse to a null suggestion so the caller
 * can fall back to its heuristic without branching on every failure
 * mode.
 */

import { AdvisorBudget } from "./budget.js";
import { decideTrigger, type TriggerDecision, type TriggerPolicy, type TriggerState } from "./trigger.js";
import type { ActionAdvisor, AdvisorCandidate, AdvisorSuggestion } from "./types.js";

export interface ConsultDeps {
  state: TriggerState;
  policy: TriggerPolicy;
  budget: AdvisorBudget;
  provider: ActionAdvisor;
  url: string;
  candidates: AdvisorCandidate[];
  screenshotSupplier: () => Promise<Buffer>;
  timeoutMs: number;
}

export type ConsultOutcome =
  | "consulted"
  | "skipped"
  | "soft_fail"
  | "out_of_range"
  | "timeout"
  | "threw";

export interface ConsultResult {
  suggestion: AdvisorSuggestion | null;
  decision: TriggerDecision;
  outcome: ConsultOutcome;
  durationMs?: number;
}

const TIMEOUT_SENTINEL = Symbol("advisor-timeout");

export async function consultAdvisor(deps: ConsultDeps): Promise<ConsultResult> {
  const decision = decideTrigger(deps.state, deps.policy, deps.candidates.length);
  if (!decision.consult || !decision.reason) {
    return { suggestion: null, decision, outcome: "skipped" };
  }

  // Reserve the budget slot up-front so concurrent attempts (future feature)
  // cannot oversubscribe the cap. Soft failures still consume budget — a
  // failed call still cost the wall clock and may have cost money.
  deps.budget.recordCall(deps.url);

  const screenshot = await deps.screenshotSupplier();
  const remaining = Math.max(0, deps.policy.maxCallsPerCrawl - deps.budget.callsThisCrawl());

  const start = Date.now();
  let raw: AdvisorSuggestion | null | typeof TIMEOUT_SENTINEL;
  try {
    raw = await Promise.race([
      deps.provider.suggest({
        url: deps.url,
        screenshot,
        candidates: deps.candidates,
        reason: decision.reason,
        budgetRemaining: remaining,
      }),
      new Promise<typeof TIMEOUT_SENTINEL>((resolve) =>
        setTimeout(() => resolve(TIMEOUT_SENTINEL), deps.timeoutMs),
      ),
    ]);
  } catch {
    return {
      suggestion: null,
      decision,
      outcome: "threw",
      durationMs: Date.now() - start,
    };
  }
  const durationMs = Date.now() - start;

  if (raw === TIMEOUT_SENTINEL) {
    return { suggestion: null, decision, outcome: "timeout", durationMs };
  }
  if (raw === null) {
    return { suggestion: null, decision, outcome: "soft_fail", durationMs };
  }
  if (
    !Number.isInteger(raw.chosenIndex) ||
    raw.chosenIndex < 0 ||
    raw.chosenIndex >= deps.candidates.length
  ) {
    return { suggestion: null, decision, outcome: "out_of_range", durationMs };
  }
  return { suggestion: raw, decision, outcome: "consulted", durationMs };
}
