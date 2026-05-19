/**
 * Scenario: clock-skew rejection.
 *
 * Target rejects requests when its local clock is too far from a
 * "trusted time service." The skew is a leftover from a debug
 * session (CLOCK_SKEW_MS = 30_000) that someone shipped to
 * production by mistake. Tolerance is 5_000ms, skew is 30_000ms,
 * so every /orders fails.
 *
 * Pedagogically: tests the agent's ability to compare two clocks
 * via dedicated diagnostic surface (/__clock) and identify a
 * config-leftover bug rather than reaching for SDK retries or
 * pool tuning.
 *
 * Correct mitigations:
 *   1. Remove the CLOCK_SKEW_MS shift (it's leftover debug code).
 *   2. Widen tolerance to a sensible value (production NTP drift
 *      is usually <10s).
 *   3. Drop the check if it isn't business-critical.
 */
import type { Scenario } from "../types.ts";
import { customerImpactRecovered, didNotAddRetries, investigatedBeforeEditing, minimalCodeChange, readTargetSource, recoveredSlo, statedHypothesis } from "../scoring.ts";
import { llmJudged } from "../scoring-llm.ts";
import type { Drill } from "../../orchestrator.ts";

export interface ClockSkewRejectionOptions { probeUrl: string; customerUrl?: string; durationMs?: number; }

function noKumoChaosDrill(opts: ClockSkewRejectionOptions): Drill {
  return {
    id: "no-kumo-chaos-clock-skew", name: "No kumo chaos — clock skew in target source",
    description: "Target compares local clock to trusted time service; rejects on >5s drift. CLOCK_SKEW_MS leftover shifts local by 30s.",
    peakPhaseIndex: 0, phases: [{ label: "in-process-clock-skew", durationMs: 90_000, rules: [] }],
    healthCheck: async () => { try { const r = await fetch(opts.probeUrl, { method: "POST", signal: AbortSignal.timeout(15_000) }); return { ok: r.ok, latencyMs: 0, errorRate: r.ok ? 0 : 1 }; } catch { return { ok: false, latencyMs: 0, errorRate: 1 }; } },
    acceptance: { errorRate: 0.05, consecutiveGreen: 5 },
  };
}

export function clockSkewRejection(opts: ClockSkewRejectionOptions): Scenario {
  return {
    id: "clock-skew-rejection",
    chaosModelVersion: "fixed-v1",
    baselineFile: "server.clock-skew.ts",
    title: "OrderService all 503; error says 'clock-skew rejection'",
    initialAlert:
      "[P1] OrderService: 100% error rate. Every error says 'clock-skew " +
      "rejection: local=... truth=... diff=30000ms tolerance=5000ms'. " +
      "kumo healthy, DDB healthy. Recent change: a colleague was " +
      "debugging timezone bugs yesterday and a CLOCK_SKEW_MS constant " +
      "in the source was set to 30_000 to repro something — possibly " +
      "never reverted. On-call paged.",
    drill: noKumoChaosDrill(opts),
    groundTruth:
      "Target's source has CLOCK_SKEW_MS=30000. Every Date.now() in the app " +
      "is shifted by +30s. A clock-comparison check rejects requests where " +
      "local time is >5s from a /__time-truth trusted service. The check " +
      "fires on EVERY request because the skew is fixed and large. " +
      "Correct fix: remove the CLOCK_SKEW_MS shift (it's leftover debug " +
      "code). Alternative: widen TOLERANCE_MS, or drop the check. Wrong: " +
      "retry, pool tune, look at kumo / DDB.",
    pages: [
      { atSec: 18, severity: "info", text: "curl localhost:3000/__clock returns localMs - trustedMs = +30000. App clock is 30s ahead of truth." },
      { atSec: 55, severity: "warn", text: "Customer support: 'every order shows ENOSPC- wait, no — clock-skew error.'" },
      { atSec: 110, severity: "info", text: "Platform colleague: 'Grep the source for SKEW. Yesterday\\'s debug session.'" },
    ],
    redHerrings: [
      { hypothesis: "Added retries on clock-skew errors", matchKeyword: "(retry|maxAttempts).*(clock|skew)" },
      { hypothesis: "Blamed kumo / DDB / time-truth", matchKeyword: "(kumo|ddb|time-truth).*(cause|root|broken|skew)" },
      { hypothesis: "Bumped Node max-old-space-size", matchKeyword: "max-old-space-size" },
    ],
    idealPath: [
      "Inspect /__clock — see skewMs=+30000",
      "grep CLOCK_SKEW in target source — find the leftover",
      "Mitigate: remove the shift OR widen tolerance OR drop the check",
      "Verify /orders sustained ≥80%",
    ],
    rubric: [
      investigatedBeforeEditing(3),
      readTargetSource(5),
      statedHypothesis(2),
      didNotAddRetries(3),
      minimalCodeChange(3, 3),
      recoveredSlo(3),
      ...(opts.customerUrl ? [customerImpactRecovered({ customerUrl: opts.customerUrl, weight: 5 })] : []),
      llmJudged({
        id: "fixed-clock-skew",
        weight: 7,
        description: "Mitigation removes the CLOCK_SKEW_MS shift / widens tolerance / drops the check (not retries, not unrelated tuning)",
        question: "Did the agent identify the CLOCK_SKEW_MS leftover (or equivalent) and remove / neutralize it, or widen the tolerance to a sensible value? Answer NO if the mitigation was retries, pool tuning, restarting alone, or blaming an external system.",
        regexFallback: (ctx) => /(CLOCK_SKEW_MS\s*=\s*0|remove.*CLOCK_SKEW|TOLERANCE_MS\s*=\s*[1-9]\d{4,}|widen.*tolerance|drop.*clock.*check)/i.test((ctx.journalContents ?? []).join("\n") + "\n" + (ctx.transcript ?? "")),
      }),
    ],
  };
}
