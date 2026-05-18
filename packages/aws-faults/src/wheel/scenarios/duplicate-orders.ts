/**
 * Scenario: duplicate orders — state correctness behind a green probe.
 *
 * Tier 6 of the capability ladder. The first scenario where outcome
 * (probe) is NOT the same as recovery.
 *
 * Setup:
 *   - Baseline: server.dup-prone.ts. writeOrder() has an idempotency
 *     violation — randomUUID() is generated INSIDE the retry loop.
 *     SDK maxAttempts=1 + socketTimeout=800ms ensures the app-level
 *     retry path fires under chaos.
 *   - Chaos: latency-timeout-trap drill. PutItem p99=2s latency, no
 *     errors. Server-side completes; client-side times out.
 *   - /orders returns 200 with the LAST successful id. Customer sees
 *     exactly one charge.
 *   - But DDB has 1-N rows per customer request. /dup-check exposes
 *     the difference: sent_ids - returned_ids = ghost rows.
 *
 * The probe (/orders) reports 100% success. The customer-support
 * page reports double-billing. State correctness is violated invisibly.
 *
 * What good agents do:
 *   1. Notice the alert mentions double-billing, not failures
 *   2. Discover /dup-check (either by reading source or by URL discovery)
 *   3. See ghosts > 0 and growing
 *   4. Read source, find randomUUID() inside the retry loop
 *   5. Move randomUUID() outside the loop (one id per request)
 *   6. Restart, verify /dup-check stops growing
 *
 * What bad agents do:
 *   - Look at /orders, see 100% success, declare "no impact"
 *   - Investigate the latency but not the duplicate count
 *   - "Fix" by adding retries (compounds the problem)
 *
 * Custom rubric primitive: noNewDuplicates probes /dup-check twice
 * post-recovery and fails if ghost count grew.
 */
import type { Scenario } from "../types.ts";
import {
  chaosRulesPreserved,
  checkedKumoChaosStats,
  customerImpactRecovered,
  didNotAddRetries,
  investigatedBeforeEditing,
  minimalCodeChange,
  noNewDuplicates,
  readTargetSource,
  recoveredSlo,
  statedHypothesis,
} from "../scoring.ts";
import { latencyTimeoutTrap } from "../../drills/latency-timeout-trap.ts";

export interface DuplicateOrdersOptions {
  probeUrl: string;
  customerUrl?: string;
  durationMs?: number;
}

export function duplicateOrders(opts: DuplicateOrdersOptions): Scenario {
  return {
    id: "duplicate-orders",
    chaosModelVersion: "fixed-v1",
    baselineFile: "server.dup-prone.ts",
    title: "OrderService probe green, but accounting flagging duplicate charges",
    initialAlert:
      "[P1] OrderService: customer-facing success rate at 99%, latency p95 elevated. " +
      "BUT accounting team flagging duplicate charges in last hour — 47 instances of " +
      "same customer charged twice for one stated order. Recent deploy noted. On-call paged.",
    drill: latencyTimeoutTrap({ probeUrl: opts.probeUrl }),
    groundTruth:
      "DDB PutItem is experiencing p99=2s latency (chaos). The target has " +
      "socketTimeout=800ms, so the slow tail throws TimeoutError client-side " +
      "while the server-side PutItem completes. The target's writeOrder has an " +
      "app-level retry that GENERATES A NEW UUID per attempt — a classic " +
      "idempotency violation. Result: timed-out attempts persist ghost rows in " +
      "DDB; only the final-attempt id is returned to the customer. /orders sees " +
      "100% success; DDB has 1-N rows per customer request. The /dup-check " +
      "endpoint reports the gap: ghosts = sent_ids - returned_ids. " +
      "Correct mitigation: move randomUUID() OUTSIDE the retry loop (one id per " +
      "writeOrder; retries reuse it; PutItem is naturally idempotent on the same key).",
    pages: [
      {
        atSec: 15,
        severity: "warn",
        text:
          "Accounting: duplicate-charge count up to 73. Pattern: same user, two " +
          "DB rows, customer reports only one order. ",
      },
      {
        atSec: 35,
        severity: "info",
        text:
          "Engineering DM: 'is /dup-check still reporting the same problem? " +
          "Last month's incident had something similar.'",
      },
      {
        atSec: 60,
        severity: "warn",
        text:
          "Datadog: PutItem p95 elevated to 1.4s. /orders endpoint p95 ~1.6s. " +
          "Success rate on /orders unchanged at 99%.",
      },
    ],
    redHerrings: [
      {
        hypothesis: "Declared recovery based on /orders success only",
        matchKeyword: "(/orders|orders endpoint).*(99%|100%).*recovered(?!.*dup)",
      },
      {
        hypothesis: "Increased retries to absorb latency (compounds duplicates)",
        matchKeyword: "(increased|added).*retries.*latency",
      },
    ],
    idealPath: [
      "Notice alert names DUPLICATE CHARGES, not failures",
      "Probe /dup-check to confirm ghost count > 0 and growing",
      "Read target source — find randomUUID() inside the retry loop",
      "Recognize: each app-retry generates a new UUID, breaking idempotency",
      "Move randomUUID() outside the retry; restart",
      "Verify /dup-check ghost count stops growing",
    ],
    rubric: [
      investigatedBeforeEditing(3),
      checkedKumoChaosStats(2),
      readTargetSource(3),
      statedHypothesis(2),
      didNotAddRetries(3),
      minimalCodeChange(3, 2),
      recoveredSlo(2),
      ...(opts.customerUrl
        ? [customerImpactRecovered({ customerUrl: opts.customerUrl, weight: 3 })]
        : []),
      chaosRulesPreserved(4),
      // The heart of the scenario. Weight 7 — heavier than any other
      // criterion, because this is the only one that catches the
      // state-correctness violation.
      noNewDuplicates({ dupCheckUrl: "http://localhost:3000/dup-check", weight: 7 }),
    ],
  };
}
