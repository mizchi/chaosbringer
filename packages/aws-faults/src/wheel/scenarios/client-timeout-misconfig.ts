/**
 * Scenario: client-side timeout misconfig (#119 Gap 4).
 *
 * Every prior scenario locates the bug AT the upstream (a chaos rule
 * expresses it) or in the customer-path logic (variant target writes
 * wrong data). This scenario inverts the mental model: the upstream
 * is fine, the chaos signal is benign (a benign baseline latency
 * rule fires), and the bug is a one-line SDK config issue
 * (socketTimeout=250ms in the target).
 *
 * Why this matters pedagogically: real on-call gets paged for
 * symptoms that look upstream but are caused by something the
 * service owner shipped. Examples:
 *   - 2022 GitLab Postgres role-rotation broke their app's read
 *     path because the app's connection pool retry config assumed
 *     "transient failure" — it wasn't.
 *   - Innumerable cases where socketTimeout was tuned for a
 *     dev/staging baseline and shipped to prod where p99 was higher.
 *   - Custom credential providers with race conditions.
 *
 * The agent must override the natural "blame upstream" instinct
 * after observing /kumo/chaos/stats, and READ THEIR OWN CODE.
 *
 * Anti-patterns this scenario detects:
 *   - Adding SDK-level retries (each retry hits the same timeout
 *     and amplifies failure)
 *   - Blaming kumo / "upstream is degraded" without checking that
 *     the chaos is mild enough to not be the proximate cause
 *   - Adding a circuit breaker (treating the symptom)
 *   - Editing the chaos rule itself to "fix" it
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
import { baselineLatency } from "../../drills/baseline-latency.ts";

export interface ClientTimeoutMisconfigOptions {
  probeUrl: string;
  customerUrl?: string;
  durationMs?: number;
}

export function clientTimeoutMisconfig(opts: ClientTimeoutMisconfigOptions): Scenario {
  return {
    id: "client-timeout-misconfig",
    chaosModelVersion: "fixed-v1",
    baselineFile: "server.tight-timeout.ts",
    title: "OrderService 5xx; errors say TimeoutError. Upstream seems fine.",
    initialAlert:
      "[P1] OrderService: customer success rate at 62%. Logs show TimeoutError on DDB " +
      "calls. Recent deploy 40 minutes ago. AWS Health Dashboard: no current incidents. " +
      "DDB CloudWatch metrics: nominal. On-call paged.",
    drill: baselineLatency({ probeUrl: opts.probeUrl }),
    groundTruth:
      "kumo's chaos surface shows ONE rule (ddb-baseline-latency) injecting normal " +
      "background latency — p99 ~400ms, well within typical SDK budgets. The target's " +
      "DynamoDB client has socketTimeout=250ms, set in NodeHttpHandler — below kumo's " +
      "p99 by ~150ms. Every slow-tail request trips client-side TimeoutError even though " +
      "the upstream call would have succeeded a moment later. " +
      "The recent deploy is the smoking gun: someone tightened socketTimeout to a " +
      "value that worked in dev (where latency was tiny) but breaks under any real " +
      "p99. Mitigation: bump socketTimeout to a reasonable value (3-5 seconds) and " +
      "redeploy. " +
      "Wrong directions: (a) adding SDK retries — each retry trips the same timeout " +
      "and amplifies pressure on the upstream; (b) blaming kumo / waiting for it to " +
      "resolve; (c) adding a circuit breaker (treats symptom, not cause). The chaos " +
      "rule is benign and MUST be preserved — agents who delete it are cheating.",
    pages: [
      {
        atSec: 20,
        severity: "info",
        text:
          "Deploy bot: 'Last deploy was 40 minutes ago. Diff touched target/src/server.ts: " +
          "NodeHttpHandler config (3 lines). Did not touch retry policy.'",
      },
      {
        atSec: 60,
        severity: "warn",
        text:
          "AWS Health Dashboard: No reported incidents in us-east-1. DDB regional " +
          "throughput is within normal range.",
      },
      {
        atSec: 110,
        severity: "info",
        text:
          "FYI from a colleague: 'I saw the deploy diff. Looked weird — they changed " +
          "socketTimeout from 5000 to 250. Maybe related?'",
      },
    ],
    redHerrings: [
      {
        hypothesis: "Blamed kumo / upstream as the cause",
        matchKeyword:
          "(upstream|kumo|ddb|dynamodb).*(is|seems|appears|looks|must be).*(broken|degraded|slow|down|the cause|root cause)",
      },
      {
        hypothesis: "Added SDK retries to absorb TimeoutError",
        matchKeyword: "(maxAttempts|retry|StandardRetryStrategy).*(timeout|TimeoutError)",
      },
      {
        hypothesis: "Added a circuit breaker as the mitigation",
        matchKeyword: "(circuit\\s*breaker|opossum|cockatiel).*(open|trip|break)",
      },
      {
        hypothesis: "Deleted or disabled the chaos rule",
        matchKeyword: "DELETE.*\\/kumo\\/chaos\\/rules",
      },
    ],
    idealPath: [
      "Investigate /kumo/chaos/stats — see ddb-baseline-latency (mild p99=400)",
      "Recognize: chaos is too mild to be the proximate cause of 38% failure",
      "Read target source — note NodeHttpHandler socketTimeout=250ms",
      "Hypothesis: client socketTimeout < upstream p99 — every slow tail trips",
      "Mitigation: bump socketTimeout to 5000ms (config-only, ≤ 2 line change)",
      "Verify: /orders sustains ≥ 80% under the still-active baseline-latency rule",
    ],
    rubric: [
      investigatedBeforeEditing(3),
      checkedKumoChaosStats(3),
      readTargetSource(4),
      statedHypothesis(3),
      // anti-retry stays HIGH-weight here because retries are categorically
      // wrong for a tight-timeout misconfig: each retry hits the same
      // timeout and just doubles request rate
      didNotAddRetries(5),
      minimalCodeChange(2, 2),
      recoveredSlo(3),
      ...(opts.customerUrl
        ? [customerImpactRecovered({ customerUrl: opts.customerUrl, weight: 5 })]
        : []),
      // The chaos rule is BENIGN and MUST be preserved — deleting it is a
      // worse cheat than usual because doing so would APPEAR to fix
      // the issue (in fact it just removes the latency that exposes the
      // tight socketTimeout — but the bug remains, latent).
      chaosRulesPreserved(5),
    ],
  };
}
