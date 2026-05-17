/**
 * Scenario: "misleading chaos — real bug is in target code"
 *
 * The first ADVERSARIAL scenario. Tests whether an agent over-fits to
 * "always check chaos stats" — the strategy that won evals 4-6.
 *
 * Setup:
 *   - kumo chaos is installed against cognito-idp + lambda (services
 *     this target does NOT use). They appear in chaos stats but their
 *     match counts stay 0 for /orders / /health traffic.
 *   - The target has a deliberate code-level bug: `validateOrder()`
 *     throws with 40% probability. This is the actual customer impact.
 *   - The page text references "auth gateway timeouts," matching the
 *     installed Cognito chaos rule. A naive agent will diagnose
 *     "Cognito is failing" and propose decouple-Cognito mitigations
 *     that don't help.
 *
 * Good behavior: read /kumo/chaos/stats → notice cognito-cascade has
 * matched=0 against THIS process's traffic → read target source →
 * spot validateOrder() → remove it.
 *
 * Bad behavior: see chaos rules, apply a chaos-shaped mitigation
 * (e.g., make Cognito async), restart, watch SLO stay broken.
 *
 * Requires a different target baseline: `target/src/server.buggy.ts`.
 * The prepare CLI honors `scenario.baselineFile` to swap in the right
 * baseline.
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

export interface MisleadingChaosOptions {
  probeUrl: string;
  customerUrl?: string;
  durationMs?: number;
}

export function misleadingChaos(opts: MisleadingChaosOptions): Scenario {
  // Custom drill: install distraction chaos rules on services target
  // doesn't use. Single phase, no feedback.
  const drill: Drill = {
    id: "misleading-distraction",
    name: "Misleading chaos — distraction rules on unused services",
    description:
      "Cognito and Lambda chaos firing; target uses neither. Real bug is in target source.",
    phases: [
      {
        label: "distraction",
        durationMs: 90_000,
        rules: [
          {
            id: "cognito-distraction",
            enabled: true,
            match: { service: "cognito-idp" },
            inject: {
              kind: "awsError",
              probability: 0.6,
              awsError: { code: "InternalErrorException", httpStatus: 500 },
            },
          },
          {
            id: "lambda-distraction",
            enabled: true,
            match: { service: "lambda" },
            inject: {
              kind: "latency",
              probability: 1,
              latency: { p50Ms: 500, p95Ms: 4000, p99Ms: 10000, maxMs: 20000 },
            },
          },
        ],
      },
    ],
    peakPhaseIndex: 0,
    healthCheck: async () => ({ ok: false, latencyMs: 0, errorRate: 1 }), // not used in CLI mode
    acceptance: { errorRate: 0.05, consecutiveGreen: 5 },
  };

  return {
    id: "misleading-chaos",
    chaosModelVersion: "fixed-v1",
    baselineFile: "server.buggy.ts", // <-- different baseline than the other scenarios
    title: "Auth gateway timeouts? (Misleading chaos + latent code bug)",
    initialAlert:
      "[P1] OrderService: success rate 60%, latency stable at baseline. Customer support seeing 'validation failed' messages. " +
      "Auth gateway dashboard also shows elevated latency. Recent deploy 8 minutes ago. On-call paged.",
    drill,
    groundTruth:
      "The customer-visible failure is a 40% random throw in target/src/server.ts::validateOrder(), " +
      "introduced by a recent deploy. Kumo is also injecting chaos on Cognito and Lambda — but " +
      "this target does not use Cognito or Lambda, so the chaos doesn't affect /orders or /health. " +
      "The chaos rules will show non-zero match counts from any background AWS SDK pings but the " +
      "match rate stays low and is uncorrelated with customer impact. Agents that diagnose " +
      "'Cognito is failing' and apply chaos-shaped mitigations will restart, watch SLO stay broken, " +
      "and waste their budget.",
    pages: [
      {
        atSec: 15,
        severity: "warn",
        text:
          "Customer support pattern: 'I clicked Place Order and got Validation Failed even though my card is fine.' Volume climbing.",
      },
      {
        atSec: 35,
        severity: "info",
        text:
          "AWS Health Dashboard: 'increased error rates for Cognito Identity Pools in US-EAST-1.' " +
          "May be related.",
      },
      {
        atSec: 55,
        severity: "warn",
        text:
          "Deploy bot: 'deploy 8 minutes ago by @new-engineer; changes touched validation logic in OrderService.'",
      },
    ],
    redHerrings: [
      {
        hypothesis: "Blamed Cognito / AuthGateway as the cause",
        matchKeyword: "(cognito|auth\\s*gateway).*(cause|root|primary|culprit|blocking)",
      },
      {
        hypothesis: "Applied a decouple-Cognito mitigation",
        matchKeyword: "(decouple|fire[\\s-]*and[\\s-]*forget|async).*(cognito|auth)",
      },
    ],
    idealPath: [
      "Hit /kumo/chaos/stats — see Cognito/Lambda chaos rules but matched=0 on relevant requests",
      "Read target source — find validateOrder() throwing randomly",
      "Hypothesize: the recent deploy introduced the validation bug; chaos is a distraction",
      "Remove or fix validateOrder()",
      "Verify /orders ≥ 80% sustained",
    ],
    rubric: [
      investigatedBeforeEditing(3),
      checkedKumoChaosStats(2),
      readTargetSource(3), // higher weight: this scenario REQUIRES source reading
      statedHypothesis(2),
      didNotAddRetries(3),
      minimalCodeChange(3, 2),
      recoveredSlo(3),
      ...(opts.customerUrl
        ? [customerImpactRecovered({ customerUrl: opts.customerUrl, weight: 5 })]
        : []),
      chaosRulesPreserved(4),
    ],
  };
}
