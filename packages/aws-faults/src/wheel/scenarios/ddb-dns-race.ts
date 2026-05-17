/**
 * Scenario: DynamoDB connection-level failures (DNS race replay)
 *
 * Wraps `aws_2025_10_20_ddb_dns_race`. Tests whether the agent
 * recognizes that the error SHAPE matters — connection-level
 * failures (ECONNRESET, hangup, socket timeout) demand different
 * mitigations from application-level errors (throttling, 5xx).
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
import { aws_2025_10_20_ddb_dns_race } from "../../drills/incidents/aws-2025-10-20-ddb-dns-race.ts";

export interface DDBDNSRaceOptions {
  probeUrl: string;
  customerUrl?: string;
  durationMs?: number;
}

export function ddbDnsRace(opts: DDBDNSRaceOptions): Scenario {
  return {
    id: "ddb-dns-race",
    chaosModelVersion: "fixed-v1",
    title: "DDB unreachable: socket hangups, no service errors",
    initialAlert:
      "[P1] OrderService: success rate down to 40%. Errors are timeouts and 'socket hangup' " +
      "— not the usual 5xx pattern. Console DDB tab is also slow to load. On-call paged.",
    drill: aws_2025_10_20_ddb_dns_race({
      probeUrl: opts.probeUrl,
    }),
    groundTruth:
      "Connection-level failures to DynamoDB (the 2025-10-20 DNS race incident shape). " +
      "Some connections are RST mid-flight; others time out. The SDK sees this as 'transient " +
      "network error,' which has a different retry shape from throttling — longer waits, " +
      "less informative logging. Mitigations that work: bound the per-call deadline so a " +
      "single hang doesn't tie up the connection pool, add a circuit breaker on connection " +
      "errors, fall back to stale data if the app has any. Mitigations that don't: " +
      "increase SDK retry count (already retrying — the retries just hang longer).",
    pages: [
      {
        atSec: 12,
        severity: "warn",
        text:
          "Datadog: TCP connection-reset metrics from app → DDB endpoint spiking. " +
          "Not service-shaped — looks like network or endpoint resolution.",
      },
      {
        atSec: 35,
        severity: "info",
        text:
          "AWS Health Dashboard: 'experiencing connection issues with the DynamoDB API endpoint in US-EAST-1. " +
          "DNS resolution may be intermittent for some clients.'",
      },
      {
        atSec: 60,
        severity: "warn",
        text:
          "Internal monitoring: DDB GetItem p99 jumped from 15ms to 8s. " +
          "Connection pool is also saturated (most slots in TIME_WAIT or pending retries).",
      },
    ],
    redHerrings: [
      {
        hypothesis: "Tried to fix DDB by scaling table capacity",
        matchKeyword: "(increase|raise|bump|scale).*(capacity|RCU|WCU|provision)",
      },
      {
        hypothesis: "Added throttling-style retry config (wrong error shape)",
        matchKeyword: "(retryMode|maxAttempts).*throttl|throttl.*retry",
      },
    ],
    idealPath: [
      "Hit /kumo/chaos/stats — see disconnect rules firing on DDB, NOT throttle",
      "Read target source — DDB calls are unbounded; no deadline",
      "Recognize: connection-level failure has different retry shape; SDK is " +
        "already trying, what's killing us is the per-call wait",
      "Add a per-call deadline + circuit breaker on connection errors",
      "Verify /orders ≥ 80% sustained",
    ],
    rubric: [
      investigatedBeforeEditing(3),
      checkedKumoChaosStats(2),
      readTargetSource(2),
      statedHypothesis(2),
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
