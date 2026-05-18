/**
 * Scenario: silent data loss — Byzantine fault on DDB PutItem.
 *
 * Tier 7 of the capability ladder. Goes beyond the duplicate-orders
 * scenario by introducing a fundamentally different fault class:
 * the upstream LIES. kumo returns 200 OK from PutItem without
 * persisting the data.
 *
 * Setup:
 *   - Baseline: server.silent-loss.ts. Like server.fragile.ts but
 *     tracks writesAcked and exposes /verify which compares against
 *     real DDB row count.
 *   - Chaos: byzantine-silent-loss drill. 40% PutItem calls return
 *     200 without persisting.
 *   - /orders returns 200 with the new id. /health succeeds.
 *     Customer thinks the order is placed.
 *   - But /verify shows `lost > 0` and growing.
 *
 * What good agents do:
 *   1. Notice alert mentions reconciliation gap, not failures
 *   2. Discover /verify endpoint, see lost > 0
 *   3. Read /kumo/chaos/rules — see silentSuccess inject kind
 *      (a NEW chaos type not seen in earlier scenarios)
 *   4. Recognize: upstream is lying. Probe-success is meaningless.
 *   5. Mitigate: add read-after-write verification (DDB ConditionExpression
 *      or follow-up GetItem on the just-written key), OR route around
 *      the lying dependency entirely.
 *
 * What bad agents do:
 *   - Probe /orders, see 100% success, declare "no impact"
 *   - "Fix" by adding retries (every retry has 40% silent-loss too)
 *   - Investigate kumo chaos and assume any inject is an error
 *
 * Custom rubric: noSilentDataLoss tracks /verify's `lost` count.
 */
import type { Scenario } from "../types.ts";
import {
  chaosRulesPreserved,
  checkedKumoChaosStats,
  customerImpactRecovered,
  didNotAddRetries,
  investigatedBeforeEditing,
  minimalCodeChange,
  noSilentDataLoss,
  readTargetSource,
  recoveredSlo,
  statedHypothesis,
} from "../scoring.ts";
import { byzantineSilentLoss } from "../../drills/byzantine-silent-loss.ts";

export interface SilentDataLossOptions {
  probeUrl: string;
  customerUrl?: string;
  durationMs?: number;
}

export function silentDataLoss(opts: SilentDataLossOptions): Scenario {
  return {
    id: "silent-data-loss",
    chaosModelVersion: "fixed-v1",
    baselineFile: "server.silent-loss.ts",
    title: "Reconciliation alert: writes-acked diverging from row count",
    initialAlert:
      "[P1] OrderService: /orders endpoint at 100% success, /health green. " +
      "BUT batch reconciliation job reports writes-acked count (5,420) " +
      "vs orders-table row count (3,250) — gap of 2,170 over last hour, " +
      "growing. No recent deploy. No latency spike. On-call paged.",
    drill: byzantineSilentLoss({ probeUrl: opts.probeUrl }),
    groundTruth:
      "DDB PutItem is returning 200 OK without actually persisting the row " +
      "(40% of the time). This is a BYZANTINE fault — the upstream is lying. " +
      "Customer probe shows healthy; in-flight requests look fine; SDK doesn't " +
      "throw; latency is normal. The only visible signal is the divergence " +
      "between writes-acked (counted in target) and ddb-count (counted via " +
      "Scan). The /verify endpoint exposes this gap. " +
      "Correct mitigation: add read-after-write verification (PutItem with " +
      "ConditionExpression that fails if the row isn't there afterward, OR a " +
      "follow-up GetItem on the just-written key to confirm presence). " +
      "Retries do not help — every retry has the same 40% probability of " +
      "silent loss.",
    pages: [
      {
        atSec: 20,
        severity: "warn",
        text:
          "Reconciliation: writes-acked count growing at ~3,000/hour; " +
          "orders-table count growing at ~1,800/hour. " +
          "Customer support: 'I placed an order and got a confirmation, but " +
          "it doesn't show up in my account.' 5 tickets in 15 minutes.",
      },
      {
        atSec: 45,
        severity: "info",
        text:
          "Probe /verify directly: GET http://localhost:3000/verify returns " +
          "{writesAcked, ddbCount, lost}.",
      },
    ],
    redHerrings: [
      {
        hypothesis: "Treated 100% probe success as evidence of recovery",
        matchKeyword: "(/orders|probe).*100%.*recovered(?!.*verify)",
      },
      {
        hypothesis: "Added retries to handle the silent loss",
        matchKeyword: "(retry|maxAttempts).*silent[\\s-]*(loss|success)",
      },
    ],
    idealPath: [
      "Probe /verify, see lost > 0 and growing",
      "Check /kumo/chaos/rules, see silentSuccess kind on PutItem",
      "Recognize: upstream LIES. probe-success ≠ persistence.",
      "Read target source: identify the PutItem call path",
      "Add read-after-write verification (GetItem after PutItem) or move " +
        "off the lying dependency",
      "Verify lost count stops growing",
    ],
    rubric: [
      investigatedBeforeEditing(3),
      checkedKumoChaosStats(2),
      readTargetSource(3),
      statedHypothesis(2),
      didNotAddRetries(3),
      minimalCodeChange(4, 2),
      recoveredSlo(2),
      ...(opts.customerUrl
        ? [customerImpactRecovered({ customerUrl: opts.customerUrl, weight: 3 })]
        : []),
      chaosRulesPreserved(4),
      // The heart of this scenario. Heaviest weight: this is the only
      // criterion that catches the Byzantine fault's actual signature.
      noSilentDataLoss({ verifyUrl: "http://localhost:3000/verify", weight: 8 }),
    ],
  };
}
