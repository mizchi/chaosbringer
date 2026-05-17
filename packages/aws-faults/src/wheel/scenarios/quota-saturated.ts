/**
 * Scenario: account-level quota saturated
 *
 * Wraps the `quotaExhaustion` drill. Tests whether the agent
 * recognizes a soft-quota error pattern as fundamentally different
 * from throttling — and avoids the "add more retries" trap that
 * works for throttling but fails for quotas.
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
import { quotaExhaustion } from "../../drills/quota-exhaustion.ts";

export interface QuotaSaturatedOptions {
  probeUrl: string;
  customerUrl?: string;
  durationMs?: number;
}

export function quotaSaturated(opts: QuotaSaturatedOptions): Scenario {
  return {
    id: "quota-saturated",
    chaosModelVersion: "fixed-v1",
    title: "DDB writes failing with LimitExceededException",
    initialAlert:
      "[P1] OrderService: success rate 35%, but latency stable at baseline. " +
      "Errors mostly LimitExceededException. Other services in the org reporting similar. " +
      "No recent deploy. On-call paged.",
    drill: quotaExhaustion({
      probeUrl: opts.probeUrl,
    }),
    groundTruth:
      "Account-level DynamoDB request quota is saturated. LimitExceededException is NOT " +
      "the same as ProvisionedThroughputExceededException — adding retries doesn't help " +
      "(retries hit the same quota). The mitigation is to reduce the rate at which we " +
      "call DDB: batch reads, cache locally, or shed load. Quota refills on a longer " +
      "timescale than per-request retry backoff.",
    pages: [
      {
        atSec: 15,
        severity: "warn",
        text:
          "Datadog: LimitExceededException rate up 40x across all DDB-using services in the account. Looks account-wide.",
      },
      {
        atSec: 35,
        severity: "info",
        text:
          "AWS Service Quotas console: 'Account-level read/write request rate hit the soft limit. " +
          "Submit a quota increase request to raise it.'",
      },
      {
        atSec: 60,
        severity: "warn",
        text:
          "Customer support: 'I keep getting Server Error when I try to place an order. I waited a few minutes and tried again — same error.'",
      },
    ],
    redHerrings: [
      {
        hypothesis: "Treated as transient throttling and added retries",
        matchKeyword: "(retry|maxAttempts).*(LimitExceeded|quota)|backoff.*LimitExceeded",
      },
      {
        hypothesis: "Tried to scale up the table's provisioned capacity",
        matchKeyword: "(increase|raise|bump).*(provision|capacity|RCU|WCU)",
      },
    ],
    idealPath: [
      "Hit /kumo/chaos/stats — see LimitExceededException firing on DDB",
      "Read target source — every order makes multiple DDB calls",
      "Recognize: this is an account-level quota, not per-table throttling",
      "Reduce the DDB call rate: batch, cache tier-config locally, or shed",
      "Verify /orders ≥ 80% sustained while the quota error is still firing",
    ],
    rubric: [
      investigatedBeforeEditing(3),
      checkedKumoChaosStats(2),
      readTargetSource(2),
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
