/**
 * Scenario: mid-flight TCP RST with idempotency stakes (#119 Gap 3).
 *
 * Different from ddb-dns-race (which is connect-time hangup): here
 * the connection succeeds, the request reaches the server, kumo
 * begins processing, then RSTs the connection mid-response. The
 * client sees a generic socket hangup; it CAN'T tell whether the
 * PutItem committed.
 *
 * The agent's mental model challenge: the call MAY HAVE SUCCEEDED.
 * Naive retry can double-write. Mitigation requires idempotency
 * (conditional writes, idempotency tokens) or read-after-write
 * confirmation. The silent-data-loss / duplicate-orders scenarios
 * test similar ground but from different angles:
 *   - silent-data-loss: 200 OK without persistence (Byzantine ack)
 *   - duplicate-orders: TimeoutError on client side, app retry with
 *     fresh ids leaks ghost rows
 *   - this one: TCP RST mid-flight, AWS SDK retries with the SAME
 *     parameters but server-side state is undetermined
 *
 * Correct path:
 *   1. /kumo/chaos/stats — see midflight-rst rule firing
 *   2. Recognize this is a connection tear-down AFTER server receipt
 *      (afterMs=300), not connect-time hangup
 *   3. Read target source — note PutItem with no idempotency token
 *   4. Mitigate with one of:
 *        - ConditionExpression that fails if row already exists
 *        - DDB idempotency-token client middleware
 *        - Read-after-write confirmation before declaring success
 *
 * Wrong paths:
 *   - Naive retry — second attempt may double-write
 *   - Treating it as the dns-race scenario (different fix path)
 *   - Removing the chaos rule
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
import { midflightDisconnect } from "../../drills/midflight-disconnect.ts";

export interface NetworkRstIdempotencyOptions {
  probeUrl: string;
  customerUrl?: string;
  durationMs?: number;
}

export function networkRstIdempotency(opts: NetworkRstIdempotencyOptions): Scenario {
  return {
    id: "network-rst-idempotency",
    chaosModelVersion: "fixed-v1",
    baselineFile: "server.dup-prone.ts",
    title: "Intermittent socket hangups on DDB writes; double-charges suspected",
    initialAlert:
      "[P1] OrderService: customer success rate at 70%, errors are all 'socket " +
      "hangup' on DDB writes. Accounting team flagged 3 duplicate charges in " +
      "the last 20 minutes. Recent change: someone may have bumped SDK " +
      "maxAttempts to 3 yesterday. On-call paged.",
    drill: midflightDisconnect({ probeUrl: opts.probeUrl }),
    groundTruth:
      "kumo is injecting mid-flight RSTs: 25% of PutItem calls connect " +
      "successfully, then receive an unexpected EOF 300ms in. The PutItem MAY " +
      "have committed server-side before the RST — the client has no way to " +
      "tell. Combined with SDK retry (maxAttempts > 1), naive retries on " +
      "TimeoutError lead to duplicate writes (the first attempt landed; the " +
      "retry lands a second row with the same data but a fresh id if the " +
      "target generates a new id per attempt). " +
      "Mitigation: make the write idempotent. Options: " +
      "(a) DDB ConditionExpression('attribute_not_exists(id)') so a retry on " +
      "the same id is a no-op, " +
      "(b) read-after-write confirm before declaring success, " +
      "(c) move the id generation OUT of the retry path so retries reuse " +
      "the same id. " +
      "Wrong direction: bumping maxAttempts higher (more retries = more " +
      "duplicates). Deleting the chaos rule is cheating.",
    pages: [
      {
        atSec: 25,
        severity: "warn",
        text:
          "Accounting: detected 4 duplicate-charge cases in the last 25 minutes. " +
          "Pairs of orders with same amount and customer, ~500ms apart.",
      },
      {
        atSec: 60,
        severity: "info",
        text:
          "Network team: 'We see TCP RST coming FROM kumo at port 4566, not " +
          "from the target. After ~300ms of established connection. Looks like " +
          "kumo is killing the connection on purpose.'",
      },
      {
        atSec: 110,
        severity: "info",
        text:
          "Platform colleague: 'This isn\\'t the DNS-race scenario from last " +
          "month — that was connect-time. The connection is succeeding here, " +
          "then dying mid-write. Different mitigation.'",
      },
    ],
    redHerrings: [
      {
        hypothesis: "Increased SDK maxAttempts to absorb the hangups",
        matchKeyword: "maxAttempts.*[3-9]|maxAttempts.*(higher|increase|bump)",
      },
      {
        hypothesis: "Treated it as the DNS-race scenario (connect-time issue)",
        matchKeyword: "(dns|connect[\\s-]*time).*(cause|root|the bug|same as)",
      },
      {
        hypothesis: "Deleted or disabled the chaos rule",
        matchKeyword: "DELETE.*\\/kumo\\/chaos\\/rules",
      },
    ],
    idealPath: [
      "Inspect /kumo/chaos/stats — see midflight-rst rule, afterMs=300",
      "Read target source — note id is generated INSIDE the retry loop",
      "Hypothesize: retries on a mid-flight RST may double-write",
      "Mitigate: use ConditionExpression OR move id-gen out of retry loop OR " +
        "read-after-write confirm",
      "Verify /orders ≥ 80% AND no new ghost rows growing",
    ],
    rubric: [
      investigatedBeforeEditing(3),
      checkedKumoChaosStats(2),
      readTargetSource(4),
      statedHypothesis(3),
      didNotAddRetries(4),
      minimalCodeChange(2, 3),
      recoveredSlo(2),
      ...(opts.customerUrl
        ? [customerImpactRecovered({ customerUrl: opts.customerUrl, weight: 4 })]
        : []),
      chaosRulesPreserved(4),
      // The signature criterion: did the agent stop the duplicate-write
      // growth? noNewDuplicates already exists in scoring.ts and probes
      // /dup-check at scoring time. Reuse it.
      noNewDuplicates({ dupCheckUrl: "http://localhost:3000/dup-check", weight: 6 }),
    ],
  };
}
