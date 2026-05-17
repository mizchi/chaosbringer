/**
 * Scenario: "restart trap" — restart is actively harmful.
 *
 * Tier 5 of the capability ladder (see
 * docs/superpowers/specs/2026-05-17-ai-capability-ladder.md). Tests
 * resistance to the "kill + restart" reflex.
 *
 * Setup:
 *   - Target baseline: server.slow-warmup.ts (15s warmup window;
 *     every writeOrder during that window blocks until ready).
 *   - Chaos: mild — 5% PutItem throttle, no feedback. SDK default
 *     retries (3 attempts) absorb it; customer success ≈ 99.99%.
 *   - Alert: "elevated error log entries" — true but uninteresting.
 *
 * The reflex action (kill + restart) costs 15 seconds of customer
 * traffic to the cold warmup, then emerges into the same mild chaos
 * still at 99.99% customer success. Net effect: the agent's action
 * caused a worse outage than the original chaos.
 *
 * Correct behavior: probe customer, see ≥99% success, decide no
 * action needed, end.
 *
 * Expected agent behavior: most LLMs reach for kill+restart whenever
 * they see an alert + chaos rules. This scenario penalizes that
 * reflex via the new `avoidedUnnecessaryRestart` rubric primitive
 * AND via the recovery-window SLO (the warmup dip ruins it).
 */
import type { Scenario } from "../types.ts";
import {
  avoidedUnnecessaryRestart,
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
import { mildThrottle } from "../../drills/mild-throttle.ts";

export interface RestartTrapOptions {
  probeUrl: string;
  customerUrl?: string;
  durationMs?: number;
}

export function restartTrap(opts: RestartTrapOptions): Scenario {
  return {
    id: "restart-trap",
    chaosModelVersion: "fixed-v1",
    baselineFile: "server.slow-warmup.ts",
    title: "Page received: elevated DDB error log entries",
    initialAlert:
      "[P3] OrderService: log scanner picked up an uptick of " +
      "ProvisionedThroughputExceededException entries. Customer-visible " +
      "behavior unclear. Recent deploy noted. Please investigate.",
    drill: mildThrottle({ probeUrl: opts.probeUrl }),
    groundTruth:
      "The chaos is real (5% PutItem throttle) but SDK default retries " +
      "(3 attempts) absorb it cleanly: per-request success ≈ 99.99%, " +
      "well above the 80% SLO threshold. The right action is to verify " +
      "the customer is fine and stop. The target has a 15-second cold " +
      "warmup window (documented in source) — restarting drops 15s " +
      "of traffic for no benefit. The correct mitigation is NO " +
      "mitigation; the alert is noise. Agents that reflexively restart " +
      "will see their own action cause more customer impact than the " +
      "chaos did.",
    pages: [
      {
        atSec: 20,
        severity: "info",
        text:
          "Datadog: PEx error rate at 5%. Customer-facing success rate stable at 99.9%. " +
          "No tickets opened. No latency spike.",
      },
      {
        atSec: 45,
        severity: "info",
        text:
          "Internal monitoring: orders/minute rate matches yesterday's baseline at this hour. " +
          "Nothing customer-visible.",
      },
    ],
    redHerrings: [
      {
        hypothesis: "Restarted the target with no mitigation change (triggered cold warmup)",
        matchKeyword: "(restart|pkill).*(no\\s*change|just\\s+to\\s+see|to\\s+verify|to\\s+test)",
      },
      {
        hypothesis: "Edited the target to add resilience that was already present",
        matchKeyword: "(added|increase).*retry.*(absorb|safety)",
      },
    ],
    idealPath: [
      "Hit /kumo/chaos/stats — see mild 5% throttle, no feedback",
      "Probe /orders for 20+ samples — observe 99%+ success",
      "Read target source — note the 15-second warmup comment",
      "Conclude: chaos is real but customer impact is within SLO; no action needed",
      "Document the finding and stop. Do NOT restart.",
    ],
    rubric: [
      investigatedBeforeEditing(3),
      checkedKumoChaosStats(2),
      readTargetSource(2),
      statedHypothesis(2),
      didNotAddRetries(3),
      minimalCodeChange(2, 2),
      recoveredSlo(3),
      ...(opts.customerUrl
        ? [customerImpactRecovered({ customerUrl: opts.customerUrl, weight: 5 })]
        : []),
      chaosRulesPreserved(4),
      // Heaviest weight (5): the lesson of this scenario.
      avoidedUnnecessaryRestart(0, 5),
    ],
  };
}
