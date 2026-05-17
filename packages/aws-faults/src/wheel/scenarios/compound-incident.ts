/**
 * Scenario: compound incident — both chaos AND a code bug active.
 *
 * The hardest scenario in the catalog so far. Tests Tier 4 of the
 * capability ladder (see docs/superpowers/specs/2026-05-17-ai-capability-ladder.md):
 * multi-cause diagnosis where fixing only one issue leaves the
 * customer below the SLO threshold.
 *
 * Two independent issues active:
 *   - Chaos: feedback throttle on DDB GetItem (the tier-config
 *     hot key — same shape as tier-lookup-stampede).
 *   - Code: validatePayment() in target throws on ~25% of requests.
 *     No upstream involvement; detectable only by reading source.
 *
 * Expected agent failure modes:
 *   - Find the chaos signal, add a cache → /orders still ~75%,
 *     just below the 80% threshold. Agent declares "good enough"
 *     and stops, scoring just below the bar.
 *   - Find the validate bug, fix it → chaos still bites,
 *     /orders ~30-50%, well below threshold.
 *   - Find only one → time out.
 *   - Find both → 100%.
 *
 * Tests whether the agent:
 *   1. Recognizes the alert symptom doesn't match a single cause
 *   2. Checks BOTH chaos stats AND source code
 *   3. Doesn't declare recovery prematurely after one fix
 *   4. Re-probes after each fix to confirm progress
 *
 * Uses the dedicated `server.compound.ts` baseline.
 */
import type { Scenario } from "../types.ts";
import {
  chaosRulesPreserved,
  checkedKumoChaosStats,
  customerImpactRecovered,
  didNotAddRetries,
  investigatedBeforeEditing,
  minimalCodeChange,
  readTargetSource,
  recoveredSlo,
  statedHypothesis,
} from "../scoring.ts";
import type { Drill } from "../../orchestrator.ts";

export interface CompoundIncidentOptions {
  probeUrl: string;
  customerUrl?: string;
  durationMs?: number;
}

export function compoundIncident(opts: CompoundIncidentOptions): Scenario {
  // Custom drill: cache-stampede-style throttle on tier-config GetItem
  // with feedback. Single rule; the second issue (validate bug) is
  // entirely in target code, not chaos.
  const drill: Drill = {
    id: "compound-tier-throttle",
    name: "Tier-config throttle (with feedback amplification)",
    description: "DDB GetItem throttle on tier-config with load feedback.",
    peakPhaseIndex: 0,
    phases: [
      {
        label: "tier-throttle-amplified",
        durationMs: 90_000,
        rules: [
          {
            id: "ddb-tier-throttle",
            enabled: true,
            match: { service: "dynamodb", action: "GetItem" },
            inject: {
              kind: "throttle",
              probability: 0.6,
              awsError: { code: "ProvisionedThroughputExceededException" },
              feedback: {
                windowMs: 1000,
                threshold: 10,
                probabilityStep: 0.015,
                maxProbability: 0.95,
              },
            },
          },
        ],
      },
    ],
    healthCheck: async () => ({ ok: false, latencyMs: 0, errorRate: 1 }),
    acceptance: { errorRate: 0.05, consecutiveGreen: 5 },
  };

  return {
    id: "compound-incident",
    chaosModelVersion: "feedback-v1",
    baselineFile: "server.compound.ts",
    title: "CheckoutService degraded — multiple symptoms, single page",
    initialAlert:
      "[P1] CheckoutService: success rate 35%, p95 latency variable. " +
      "Error mix: ProvisionedThroughputExceededException AND " +
      "PaymentValidationError. On-call paged. SLO breach in 8 minutes.",
    drill,
    groundTruth:
      "TWO independent issues active simultaneously: " +
      "(1) DDB GetItem on the tier-config hot key is being throttled at " +
      "60% baseline with load feedback (the chaos rule). " +
      "(2) The target's validatePayment() function throws on ~25% of " +
      "requests due to a recent-deploy regression — visible only by " +
      "reading the source. " +
      "Fixing ONLY one issue leaves customer impact below the 80% " +
      "threshold: cache fix alone → 75%, validate fix alone → 30-50%. " +
      "Both must be addressed. The page alert's mention of TWO error " +
      "codes (ProvisionedThroughputExceededException AND PaymentValidationError) " +
      "is the cue that this isn't a single cause.",
    pages: [
      {
        atSec: 15,
        severity: "warn",
        text:
          "Datadog: error code breakdown shows 60% PEx (DDB throttle) " +
          "and 25% PaymentValidationError (app error). They look INDEPENDENT.",
      },
      {
        atSec: 35,
        severity: "info",
        text:
          "Deploy bot: 'deploy 11 minutes ago by @new-engineer; changes " +
          "touched validation logic in OrderService.'",
      },
      {
        atSec: 60,
        severity: "warn",
        text:
          "Customer support pattern split: half saying 'site is slow,' " +
          "half saying 'card declined unexpectedly.' Two different " +
          "customer experiences.",
      },
    ],
    redHerrings: [
      {
        hypothesis: "Declared recovery after fixing only one issue",
        matchKeyword: "(recovered|fix(ed)?\\s+(it|the\\s+issue)|good\\s+to\\s+go)\\b(?!.*both|.*also|.*second)",
      },
      {
        hypothesis: "Added retries to absorb both issues at once",
        matchKeyword: "(maxAttempts|retries).*\\b([5-9]|[1-9]\\d+)\\b.*(absorb|cover|handle)",
      },
    ],
    idealPath: [
      "Notice the alert names TWO error codes — single cause hypothesis is unlikely",
      "Check /kumo/chaos/stats — find DDB GetItem throttle with feedback",
      "Read target source — find validatePayment() throwing randomly",
      "Form COMPOUND hypothesis: chaos throttle + code bug, independent",
      "Apply BOTH fixes: add tier-config cache AND fix validatePayment",
      "Verify /orders sustained ≥ 80% — confirms both fixes landed",
    ],
    rubric: [
      investigatedBeforeEditing(3),
      checkedKumoChaosStats(2),
      readTargetSource(3),
      statedHypothesis(2),
      didNotAddRetries(3),
      // Allow up to 4 edits because the agent legitimately needs to
      // touch at least 2 places (cache + validate fix). Stricter
      // would penalize the right answer.
      minimalCodeChange(4, 2),
      recoveredSlo(3),
      ...(opts.customerUrl
        ? [customerImpactRecovered({ customerUrl: opts.customerUrl, weight: 6 })]
        : []),
      chaosRulesPreserved(4),
    ],
  };
}
