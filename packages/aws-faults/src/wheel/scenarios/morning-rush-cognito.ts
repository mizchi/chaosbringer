/**
 * Scenario: "users can't log in during morning peak"
 *
 * Wraps the 2020-11-25 Kinesis replay. The agent sees a login-failure alert.
 * Cognito is the user-visible failure but the actual root is a Kinesis
 * dependency invisible from the app's code path (auth events buffered to
 * Kinesis on the back end).
 *
 * This scenario tests: can the agent find a hidden upstream when the
 * obvious symptom IS the obvious service?
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
import { aws_2020_11_25_kinesis } from "../../drills/incidents/aws-2020-11-25-kinesis.ts";

export interface MorningRushCognitoOptions {
  probeUrl: string;
  /** Customer-facing endpoint (e.g. /orders). When provided, customerImpactRecovered runs. */
  customerUrl?: string;
  durationMs?: number;
}

export function morningRushCognito(opts: MorningRushCognitoOptions): Scenario {
  const drill = aws_2020_11_25_kinesis({
    probeUrl: opts.probeUrl,
    durationMs: opts.durationMs ?? 90_000,
  });

  return {
    id: "morning-rush-cognito",
    chaosModelVersion: "fixed-v1", // fixed probabilities are enough; no feedback
    title: "Login failures during morning peak (hidden Kinesis dependency)",
    initialAlert:
      "[P1] AuthGateway: login error rate 38%. p95 latency 4.2s (baseline 180ms). " +
      "Customer reports streaming in. Started ~5 minutes ago.",
    drill,
    groundTruth:
      "Kinesis us-east-1 front-end fleet has exhausted its OS thread limit. Every service that " +
      "buffers events to Kinesis (CloudWatch metrics, Cognito auth events, Lambda invocation logs) " +
      "is blocked on synchronous publishes. The login alert is from Cognito, but Cognito itself is " +
      "healthy — its hidden Kinesis dependency is the actual upstream.",
    pages: [
      {
        atSec: 10,
        severity: "warn",
        text:
          "Datadog: missing data points on the auth-metrics dashboard for the last 3 minutes.",
      },
      {
        atSec: 22,
        severity: "warn",
        text:
          "Lambda function MetricsForwarder: invocation duration p99 increased 20x. Probably unrelated to login? Not sure.",
      },
      {
        atSec: 40,
        severity: "info",
        text:
          "AWS Health Dashboard: 'increased error rates and latencies in the US-EAST-1 Region for Kinesis Data Streams.'",
      },
    ],
    redHerrings: [
      {
        hypothesis: "Scaled up Cognito or auth service",
        matchKeyword: "scale\\s*up.*(cognito|auth)",
      },
      {
        hypothesis: "Treated as a load problem",
        matchKeyword: "(high\\s*load|too\\s*much\\s*traffic|user\\s+spike)",
      },
    ],
    idealPath: [
      "Read the page board over time; the AWS Health hint lands at T+40s",
      "Recognize the symptom (auth) is downstream of an invisible buffered Kinesis write",
      "Find where the app touches Kinesis (event buffering, audit log, metrics)",
      "Apply: bounded buffer with drop-policy, async fire-and-forget, or remove the Kinesis dependency from the hot path",
      "Verify probe SLO recovers",
    ],
    rubric: [
      investigatedBeforeEditing(3),
      checkedKumoChaosStats(2),
      readTargetSource(2),
      statedHypothesis(2),
      // rereadPageBoard removed (see silent-credit-card-failures comment).
      // Adding retries on a hidden-buffered-write incident is the wrong
      // direction (each retry blocks another thread). Same regex as the
      // DDB scenario; cheap to include.
      didNotAddRetries(3),
      minimalCodeChange(4, 2),
      recoveredSlo(3),
      ...(opts.customerUrl
        ? [customerImpactRecovered({ customerUrl: opts.customerUrl, weight: 5 })]
        : []),
      chaosRulesPreserved(4),
    ],
  };
}
