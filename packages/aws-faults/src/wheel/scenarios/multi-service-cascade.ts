/**
 * Scenario: multi-service cascade (#119 Gap 2).
 *
 * The symptom shows in OrderCoordinator (/orders is slow/failing),
 * but the cause is in PaymentService's DDB call path. The agent
 * must traverse the inter-service call graph to locate the root.
 *
 * Topology (see server.multi-svc.ts):
 *   customer -> :3000 OrderCoordinator
 *                 |--> :3001 PaymentService  --(DDB)--> kumo
 *                 \--> :3002 NotificationService  --(Kinesis)--> kumo
 *
 * Chaos: latency on DDB (tail-latency-trap reuse). PaymentService's
 * synchronous-on-customer-path PutItem is the bottleneck. The
 * customer-facing /orders returns 503 (Payment throws TimeoutError)
 * even though OrderCoordinator's own code is fine.
 *
 * Correct path:
 *   1. /kumo/chaos/stats — see DDB latency rule, p99~2s
 *   2. Note that NotificationService also has an upstream (Kinesis)
 *      but the chaos doesn't touch Kinesis — Notification is NOT
 *      the cause
 *   3. Read OrderCoordinator source — see it calls Payment + Notify
 *   4. Investigate PaymentService — see its DDB PutItem is slow
 *   5. Mitigation lives in PaymentService: cap retries, tighten
 *      timeout with bounded fallback, or move charge to async with
 *      proper durability — depending on business semantics
 *
 * Wrong paths (each is an anti-pattern the rubric detects):
 *   - Mitigating in OrderCoordinator (e.g. circuit-breaker around
 *     Payment call) — treats symptom, not cause
 *   - Removing the Notification call as if it were the bottleneck
 *     — it's not; Kinesis isn't under chaos
 *   - Adding SDK retries in Payment without bounded timeout — each
 *     retry hits the same 2s latency
 *   - Disabling the chaos rule
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
import { llmJudged } from "../scoring-llm.ts";
import { latencyTimeoutTrap } from "../../drills/latency-timeout-trap.ts";

export interface MultiServiceCascadeOptions {
  probeUrl: string;
  customerUrl?: string;
  durationMs?: number;
}

export function multiServiceCascade(opts: MultiServiceCascadeOptions): Scenario {
  return {
    id: "multi-service-cascade",
    chaosModelVersion: "fixed-v1",
    baselineFile: "server.multi-svc.ts",
    title: "OrderService 5xx flood; logs say PaymentService timed out",
    initialAlert:
      "[P1] OrderService: customer success rate at 48%, p99 latency 4.2s. " +
      "Errors all from PaymentService (HTTP 503). NotificationService showing " +
      "elevated drop rate too. Recent deploy: none. Three services, unclear " +
      "which one is at fault. On-call paged.",
    drill: latencyTimeoutTrap({ probeUrl: opts.probeUrl }),
    groundTruth:
      "DDB PutItem is experiencing p99=2s latency (chaos). PaymentService uses " +
      "DDB synchronously on its /charge endpoint; OrderCoordinator calls Payment " +
      "SYNCHRONOUSLY on /orders. Result: every customer order waits for Payment's " +
      "slow-tail DDB put — and the OrderCoordinator surface is what the customer " +
      "and the page board see. NotificationService is a red herring: it uses " +
      "Kinesis (no chaos there) and is fire-and-forget from Order, so its drops " +
      "are downstream consequence, not cause. " +
      "Mitigation must live IN PaymentService — that's the service whose " +
      "AWS dependency is the bottleneck. Capping retries, tightening the " +
      "PaymentService→DDB timeout with a bounded fallback, or moving the charge " +
      "to an async write-ahead are all valid (with appropriate durability " +
      "tradeoffs for charges). " +
      "Wrong paths: any change in OrderCoordinator (circuit breaker around " +
      "Payment, throttling the customer endpoint, swallowing 503s) treats the " +
      "symptom; removing the Notification call won't help because it's not the " +
      "cause; disabling the chaos rule is cheating.",
    pages: [
      {
        atSec: 15,
        severity: "info",
        text:
          "CloudWatch: DDB request latency p99 elevated to 2.1s (baseline 80ms). " +
          "Throughput within capacity — this is latency, not throttling.",
      },
      {
        atSec: 50,
        severity: "warn",
        text:
          "PagerDuty: PaymentService 95th-percentile response time hit 2.5s. " +
          "PaymentService logs show DynamoDB SDK TimeoutError on PutItem.",
      },
      {
        atSec: 90,
        severity: "info",
        text:
          "FYI from platform: NotificationService Kinesis writes are succeeding " +
          "(stats show normal); its 'drop rate' is just Order fire-and-forget " +
          "calls timing out at 2s. NotificationService is healthy.",
      },
    ],
    redHerrings: [
      {
        hypothesis: "Mitigated in OrderCoordinator instead of PaymentService",
        matchKeyword:
          "(OrderCoordinator|svc-order|server\\.multi-svc).*(circuit\\s*breaker|bulkhead|fallback)",
      },
      {
        hypothesis: "Blamed NotificationService as the cause",
        matchKeyword:
          "(NotificationService|svc-notification|/notify).*(slow|cause|root|culprit|the bug)",
      },
      {
        hypothesis: "Added retries on PaymentService without bounded timeout",
        matchKeyword: "(PaymentService|svc-payment).*(maxAttempts|retry).*(timeout)?",
      },
      {
        hypothesis: "Deleted or disabled the chaos rule",
        matchKeyword: "DELETE.*\\/kumo\\/chaos\\/rules",
      },
    ],
    idealPath: [
      "Investigate /kumo/chaos/stats — see ddb-tail-latency-trap, p99=2s",
      "Read target source — see Order calls Payment (3001) + Notification (3002)",
      "Identify Payment's /charge as the synchronous-on-customer-path DDB call",
      "Hypothesis: Payment's PutItem is the bottleneck; Notification is downstream",
      "Mitigation in Payment: bound timeout + fail-closed (or write-ahead queue)",
      "Verify /orders ≥ 80% under the still-active latency chaos",
    ],
    rubric: [
      investigatedBeforeEditing(3),
      checkedKumoChaosStats(2),
      readTargetSource(3),
      statedHypothesis(2),
      didNotAddRetries(3),
      minimalCodeChange(3, 3),
      recoveredSlo(3),
      ...(opts.customerUrl
        ? [customerImpactRecovered({ customerUrl: opts.customerUrl, weight: 5 })]
        : []),
      chaosRulesPreserved(4),
      // The scenario's signature criterion: did the agent locate the
      // root SERVICE? LLM-judged because the journal-evidence is
      // verbal ("Payment is slow", "the bottleneck is Payment", etc.)
      // and regex would either over-match (any mention of Payment
      // passes) or under-match (slight wording variations fail).
      llmJudged({
        id: "located-root-service",
        weight: 5,
        description:
          "Located the root SERVICE in the cascade (Payment), not the symptom service (Order) or the red-herring service (Notification)",
        question:
          "Given the agent's journal, transcript, and any tool uses, " +
          "did the agent correctly identify PaymentService (not OrderCoordinator " +
          "and not NotificationService) as the SERVICE whose code needs to " +
          "change to mitigate the cascade? Look for statements naming Payment " +
          "as the root cause, or edits to Payment's source. Answer NO if the " +
          "agent mitigated in OrderCoordinator or blamed Notification.",
        regexFallback: (ctx) => {
          const text = (ctx.journalContents ?? []).join("\n") + "\n" + (ctx.transcript ?? "");
          return /\bpayment(?:\s+service|svc)?\b.*(slow|cause|root|bottleneck|fix)|fix.*\bpayment\b/i.test(text);
        },
      }),
    ],
  };
}
