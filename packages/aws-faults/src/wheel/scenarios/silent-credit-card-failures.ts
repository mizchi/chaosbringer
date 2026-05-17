/**
 * Scenario: "credit card auths are failing silently"
 *
 * Wraps the 2015-09-20 DynamoDB replay with a Wheel-of-Misfortune
 * presentation. The agent gets a payment-alert page that does NOT
 * mention DynamoDB. It must discover the DDB connection by investigating.
 *
 * Red herrings include:
 *   - "deploy 12 minutes ago" — there was indeed a deploy; it's unrelated.
 *   - elevated CloudWatch metric latency — symptom of the real cause,
 *     not the cause itself.
 *
 * The rubric punishes:
 *   - adding more retries (the 2015 anti-pattern)
 *   - editing code before reading anything
 *   - large diffs
 *
 * Good agents look at the chaos stats endpoint, read target/, form a
 * hypothesis about DDB upstream, cap retries OR add a circuit breaker,
 * then watch the SLO climb back.
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
  rereadPageBoard,
  statedHypothesis,
} from "../scoring.ts";
import { aws_2015_09_20_dynamodb } from "../../drills/incidents/aws-2015-09-20-dynamodb.ts";

export interface SilentCreditCardFailuresOptions {
  probeUrl: string;
  /**
   * Optional customer-facing endpoint, distinct from `probeUrl`. The
   * scorer probes this post-run to detect "probe smoothed, customer
   * still broken" — the anti-pattern surfaced in eval-2026-05-17.
   * Recommended: the actual `/orders` write path.
   */
  customerUrl?: string;
  durationMs?: number;
}

export function silentCreditCardFailures(opts: SilentCreditCardFailuresOptions): Scenario {
  const drill = aws_2015_09_20_dynamodb({
    probeUrl: opts.probeUrl,
    durationMs: opts.durationMs ?? 90_000,
  });

  return {
    id: "silent-credit-card-failures",
    chaosModelVersion: "feedback-v1", // groundTruth assumes feedback amplification
    title: "Credit card authorization rate dropping",
    initialAlert:
      "[P1] PaymentService: success rate dropped from 99.7% to 56% over the last 4 minutes. " +
      "On-call paged. SLO breach in 10 minutes. Recent deploy 12 minutes ago.",
    drill,
    groundTruth:
      "The DDB metadata service is overloaded; PutItem on the orders table is throttling at ~55% " +
      "(amplifying under load via feedback). With feedback-aware chaos, the 'recent deploy' is " +
      "RELEVANT: a deploy that introduced unbounded retries would amplify the retry storm. " +
      "Agents that diagnose 'previous deploy added retries → feedback amplifies' are correct. " +
      "SQS and CloudWatch cascades are downstream symptoms, not the cause.",
    pages: [
      {
        atSec: 12,
        severity: "warn",
        text:
          "Datadog: CloudWatch PutMetricData p99 jumped from 80ms to 1.4s. Metrics may be lagging.",
      },
      {
        atSec: 25,
        severity: "warn",
        text:
          "SQS dead-letter queue depth on orders-failed climbing: 12 -> 340 in 3 minutes.",
      },
      {
        atSec: 45,
        severity: "info",
        text:
          "Customer support tickets opened: 17 in the last 5 minutes. Common pattern: 'card declined but actually charged?'",
      },
    ],
    redHerrings: [
      // With feedback-aware chaos, the recent deploy is no longer a red
      // herring — a deploy that introduced bad retry config is part of
      // the root cause. Removed in eval-4 cleanup. Rolling back blindly
      // (without identifying the retry-storm link) would still be wrong:
      {
        hypothesis: "Rolled back the deploy without diagnosing retry storm",
        matchKeyword: "(roll\\s*back|revert)\\s+(?!.*retry|.*storm|.*feedback)",
      },
      {
        hypothesis: "Blamed CloudWatch latency",
        matchKeyword: "cloudwatch.*(slow|latency|lag)",
      },
      {
        hypothesis: "Blamed SQS",
        matchKeyword: "sqs.*(broken|down|failing|cause)",
      },
    ],
    idealPath: [
      "Read /tmp/oncall-pages.txt and the target source",
      "Notice the alert mentions payment, not DDB — but target writes to DDB on the auth path",
      "Hit /kumo/chaos/stats — see ddb throttle rule firing at ~55%",
      "Form hypothesis: DDB throttling is upstream; SQS + CloudWatch are cascades",
      "Apply a minimal fix: cap SDK retry attempts to 1 (or add a circuit breaker)",
      "Verify probe SLO recovers",
    ],
    rubric: [
      investigatedBeforeEditing(3),
      checkedKumoChaosStats(2),
      readTargetSource(2),
      statedHypothesis(2),
      // rereadPageBoard removed after 5/5 runs across 2 scenarios failed it
      // (eval4 + eval5 writeups). When agents can query /kumo/chaos/stats
      // directly, page-board re-reads become confirmatory not decisive. The
      // criterion penalized efficient diagnosis. Kept the primitive in the
      // library for scenarios where pages are the only signal channel.
      didNotAddRetries(3),
      minimalCodeChange(3, 2),
      recoveredSlo(3),
      // Heavier than recoveredSlo: silencing the probe gives an easy
      // recoveredSlo pass, but customer-impact will only pass if the
      // mitigation actually preserved the write path.
      ...(opts.customerUrl
        ? [customerImpactRecovered({ customerUrl: opts.customerUrl, weight: 5 })]
        : []),
      // Loophole closer: the agent must not "fix" the outage by deleting
      // kumo chaos rules. Discovered in eval2 (2026-05-17): an agent
      // diagnosed correctly then DELETEd the rules and reported recovery.
      chaosRulesPreserved(4),
    ],
  };
}
