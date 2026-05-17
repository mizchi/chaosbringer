/**
 * Scenario: no-hints feedback storm.
 *
 * Tier 5 of the capability ladder. Identical chaos to
 * silent-credit-card-failures (feedback throttle storm on DDB) but
 * with ALL hints stripped from the brief, page text, and groundTruth.
 *
 * Tests whether agents reach the correct mitigation by independent
 * discovery vs. by following the breadcrumbs we put down for them.
 *
 * What's stripped vs silent-credit-card-failures:
 *   - No mention of TWO error codes in the alert
 *   - No deploy-bot signal about validation
 *   - No CloudWatch / SQS cascade chatter on the page board
 *   - No "feedback-aware chaos" warning in the brief
 *   - GroundTruth in debrief is verbose; alert is minimal
 *
 * The page text is INFORMATIONAL only:
 *   "Customer support seeing 'order failed' patterns."
 * Nothing about which service is upstream. Nothing about feedback.
 * Nothing about the recent deploy that introduced the retry config.
 *
 * Tests:
 *   - Does the agent check chaos stats without being told to?
 *   - Does the agent notice feedback parameters in the rule shape?
 *   - Does the agent reason about retry × feedback interaction
 *     without the brief naming it?
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
import { aws_2015_09_20_dynamodb } from "../../drills/incidents/aws-2015-09-20-dynamodb.ts";

export interface NoHintsStormOptions {
  probeUrl: string;
  customerUrl?: string;
  durationMs?: number;
}

export function noHintsStorm(opts: NoHintsStormOptions): Scenario {
  return {
    id: "no-hints-storm",
    chaosModelVersion: "feedback-v1",
    title: "OrderService elevated errors (no further detail)",
    initialAlert:
      "[P1] OrderService: success rate down. Customer support seeing 'order failed' patterns. On-call paged.",
    drill: aws_2015_09_20_dynamodb({
      probeUrl: opts.probeUrl,
      durationMs: opts.durationMs ?? 90_000,
    }),
    groundTruth:
      "Same underlying chaos as silent-credit-card-failures: feedback " +
      "throttle on DDB with retry-storm amplification. But the brief, " +
      "alert, and page board contain ZERO diagnostic hints. The agent " +
      "must independently: (1) check /kumo/chaos/stats, (2) notice the " +
      "feedback config on the rule, (3) read target source to understand " +
      "the request shape, (4) reason about retry × feedback interaction. " +
      "Correct mitigation is the same as silent-credit-card-failures: " +
      "cap retries + backoff longer than the feedback window.",
    pages: [
      {
        atSec: 25,
        severity: "warn",
        text: "Probe latency p95 doubled. No other detail.",
      },
      {
        atSec: 50,
        severity: "warn",
        text: "Customer support: ticket volume up 4x in 10 minutes.",
      },
    ],
    redHerrings: [],
    idealPath: [
      "Without being prompted, query /kumo/chaos/stats AND read source",
      "Notice the rule's feedback configuration",
      "Reason: retry storms will worsen the feedback amplification",
      "Apply mitigation: cap retries OR backoff > feedback window",
      "Verify /orders sustained ≥ 80%",
    ],
    rubric: [
      // Investigation weight bumped to 4 because without hints, the
      // investigation step is what separates competent from lucky.
      investigatedBeforeEditing(4),
      checkedKumoChaosStats(3), // also bumped — without hints, this is
                                // the only way to find the upstream
      readTargetSource(3),
      statedHypothesis(2),
      didNotAddRetries(3),
      minimalCodeChange(3, 2),
      recoveredSlo(3),
      ...(opts.customerUrl
        ? [customerImpactRecovered({ customerUrl: opts.customerUrl, weight: 6 })]
        : []),
      chaosRulesPreserved(4),
    ],
  };
}
