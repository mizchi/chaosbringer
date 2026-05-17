/**
 * Scenario: "warm-up DDB throttle drill"
 *
 * Wraps the simpler `ddbThrottleStorm` drill (no time-shape, no
 * cascades, no feedback). Intended as a first-run "are the harness
 * mechanics working" smoke test, or as a baseline against which to
 * compare more elaborate scenarios.
 *
 * Where the other scenarios test reasoning:
 *   - silentCreditCardFailures: retry feedback + storm dynamics
 *   - morningRushCognito: hidden upstream
 *   - checkoutReceiptsStalled: durability-preserving decouple
 *
 * This scenario tests baseline operational discipline:
 *   - Did you investigate before editing?
 *   - Did you check the chaos endpoint?
 *   - Did you preserve the probe semantics?
 *
 * Useful as a calibration scenario when running multi-shot evals.
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
import { ddbThrottleStorm } from "../../drills/ddb-throttle-storm.ts";

export interface DDBThrottleWarmupOptions {
  probeUrl: string;
  customerUrl?: string;
  durationMs?: number;
}

export function ddbThrottleWarmup(opts: DDBThrottleWarmupOptions): Scenario {
  // The drill is simple-mode (just `rules`, no phases). The prepare CLI
  // handles both shapes — when phases is empty, it reads `rules` directly.
  const drill = ddbThrottleStorm({
    probeUrl: opts.probeUrl,
    probability: 0.5,
  });

  return {
    id: "ddb-throttle-warmup",
    chaosModelVersion: "fixed-v1",
    title: "DDB throttling at moderate rate (warm-up)",
    initialAlert:
      "[P2] OrderService: error rate elevated at ~20% over the last 6 minutes. " +
      "No recent deploys, no other alerts firing. On-call paged.",
    drill,
    groundTruth:
      "Synthetic DDB throttling at 50% on PutItem. No cascade, no feedback, " +
      "no time-shape. Simplest possible drill — verifies the agent finds " +
      "the upstream and applies a non-cheating fix (cap retries OR add a " +
      "circuit breaker).",
    pages: [
      {
        atSec: 20,
        severity: "info",
        text: "AWS Health Dashboard: 'increased error rates for DynamoDB in US-EAST-1' (informational).",
      },
    ],
    redHerrings: [],
    idealPath: [
      "Read pages + target source",
      "GET /kumo/chaos/stats — see ddb-throttle-storm firing at 50%",
      "Cap retries OR add a circuit breaker",
      "Verify /orders ≥ 80% sustained while chaos still firing",
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
