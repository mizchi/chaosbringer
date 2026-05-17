/**
 * Scenario: "checkout receipts are stalling"
 *
 * Wraps the 2017-02-28 S3 us-east-1 replay. The agent gets a generic
 * "checkout latency spiked" alert. The actual fault is S3 PutObject
 * returning 5xx and tail-latency on the customer write path (the
 * receipt-archival step).
 *
 * What's different from the DDB and Kinesis scenarios:
 *
 *   - DDB scenario lesson: retry storms amplify when the upstream
 *     can feedback on load. Mitigation = REDUCE retry pressure.
 *   - Kinesis scenario lesson: invisible buffered dependencies block
 *     the customer path. Mitigation = DECOUPLE non-critical writes.
 *   - S3 receipt lesson: receipts are NOT non-critical (regulatory,
 *     reconciliation needs). Can't simply fire-and-forget. Mitigation
 *     must preserve durability — typically a local write-ahead queue
 *     with background sync OR a short timeout + retry-on-different-key.
 *
 * Good agents discover that "make receipts async" is the wrong shortcut
 * because receipts must be durable. They reach for a queue or a
 * retry-with-different-prefix pattern.
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
import { aws_2017_02_28_s3 } from "../../drills/incidents/aws-2017-02-28-s3.ts";

export interface CheckoutReceiptsStalledOptions {
  probeUrl: string;
  customerUrl?: string;
  durationMs?: number;
}

export function checkoutReceiptsStalled(opts: CheckoutReceiptsStalledOptions): Scenario {
  const drill = aws_2017_02_28_s3({
    probeUrl: opts.probeUrl,
    durationMs: opts.durationMs ?? 90_000,
  });

  return {
    id: "checkout-receipts-stalled",
    title: "Checkout latency spiking; receipts taking forever",
    initialAlert:
      "[P1] CheckoutService: p95 latency 6.3s (baseline 220ms). Success rate dropped to 71%. " +
      "Background-job dashboards (Lambda, EBS snapshots, EC2 launches) also showing elevated " +
      "errors but unclear if related. On-call paged.",
    drill,
    groundTruth:
      "S3 us-east-1 PutObject is returning 5xx and high tail latency. The target writes a " +
      "receipt object to S3 synchronously on the order path; that single S3 dependency is " +
      "the customer-visible bottleneck. The 'background jobs failing' note in the alert is " +
      "the 2017-S3 cascade — many services depend on S3, and they're affected too, but for " +
      "THIS app the customer path is the receipt write. " +
      "Naive fix (fire-and-forget) is wrong here: receipts are auditable / regulatory. " +
      "The correct mitigation is a local write-ahead buffer with background sync, OR a " +
      "short timeout + accepting partial durability with explicit out-of-band reconciliation.",
    pages: [
      {
        atSec: 15,
        severity: "warn",
        text: "Datadog: EBS snapshot creation also slow. Probably unrelated to checkout latency? Worth checking dependencies.",
      },
      {
        atSec: 35,
        severity: "info",
        text: "AWS Health Dashboard: 'increased error rates and latencies for S3 in US-EAST-1.'",
      },
      {
        atSec: 50,
        severity: "warn",
        text:
          "Customer support: 9 tickets in 8 minutes. 'Order placed but I never got my receipt email.' " +
          "Receipt email is sent FROM the receipt S3 object via a downstream consumer.",
      },
    ],
    redHerrings: [
      // Naive shortcut: making the write fire-and-forget like the Kinesis
      // scenario — but receipts must be durable. Detect mentions of
      // "fire-and-forget" / "ignore S3 errors" / etc. without a queue
      // or durability mechanism.
      {
        hypothesis: "Made receipt write fire-and-forget without preserving durability",
        matchKeyword: "(fire[\\s-]*and[\\s-]*forget|detach|swallow.*error|ignore.*s3.*error|.catch\\(.*\\) =>)\\s*(?!.*queue|.*buffer|.*reconcile|.*persist)",
      },
      {
        hypothesis: "Blamed EBS or EC2 launches as the cause",
        matchKeyword: "(ebs|ec2)\\s+(snapshot|launch).*(cause|root|primary)",
      },
    ],
    idealPath: [
      "Read pages, check /kumo/chaos/* — see s3-* rules firing hot",
      "Read target source — discover the receipt S3 write on order path",
      "Recognize: receipts cannot simply be dropped (regulatory / customer)",
      "Apply durability-preserving mitigation: in-memory or disk-backed queue " +
        "with background flush, with a short S3 timeout so the customer path " +
        "isn't blocked when the queue is added",
      "Verify /orders ≥ 80% sustained while chaos is still firing",
    ],
    rubric: [
      investigatedBeforeEditing(3),
      checkedKumoChaosStats(2),
      readTargetSource(2),
      statedHypothesis(2),
      // Same retry guard as the other scenarios. S3 SDK default retries
      // can cause similar amplification if extended.
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
