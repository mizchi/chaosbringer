/**
 * Scenario: TCP-level DNS storm / cross-AZ partition (#119 Gap 3).
 *
 * Adds a third connection-level failure pattern to the catalog,
 * distinct from the prior two:
 *
 *   - ddb-dns-race:           kumo `disconnect` afterMs=0 / 100.
 *                             Connection established, then hangup.
 *   - network-rst-idempotency: kumo `disconnect` afterMs=300.
 *                             Connection established, body received,
 *                             then mid-flight RST. Server-side state
 *                             may have changed.
 *   - dns-storm (this):       TCP chaos proxy refuses connections
 *                             BEFORE they reach kumo. The SDK sees
 *                             ECONNREFUSED at connect time. No
 *                             server-side state is touched.
 *
 * Mental model: a partial DNS outage / cross-AZ partition where
 * some fraction of new outbound sockets simply fail to establish.
 * Existing connections (pooled SDK sockets) are fine. The fix is
 * about reachability and connection lifecycle, not about
 * idempotency or pool tuning.
 *
 * Correct mitigations (any of):
 *   - Bounded retry-with-backoff on connect-time errors specifically
 *     (the connection didn't reach kumo; safe to retry without
 *     idempotency concerns)
 *   - SDK socket reuse / keepalive (an established socket isn't
 *     affected by the connect-refuse chaos)
 *   - Failover to a different endpoint or AZ (in a real multi-AZ
 *     deployment)
 *
 * Wrong directions:
 *   - Adding idempotency tokens / read-after-write (wrong layer;
 *     the call never reached the server)
 *   - Looking at kumo chaos rules (the chaos is in the TCP proxy,
 *     not kumo)
 *   - Editing DDB error handling (the error isn't from DDB)
 *
 * Setup requirement: the harness must start scripts/tcp-chaos-proxy.ts
 * before this scenario's target. The variant installs the chaos
 * rule via the proxy admin endpoint at startup.
 */
import type { Scenario } from "../types.ts";
import {
  customerImpactRecovered,
  didNotAddRetries,
  investigatedBeforeEditing,
  minimalCodeChange,
  readTargetSource,
  recoveredSlo,
  statedHypothesis,
} from "../scoring.ts";
import { llmJudged } from "../scoring-llm.ts";
import type { Drill } from "../../orchestrator.ts";

export interface DnsStormOptions {
  probeUrl: string;
  customerUrl?: string;
  durationMs?: number;
}

function noKumoChaosDrill(opts: DnsStormOptions): Drill {
  return {
    id: "no-kumo-chaos-tcp-proxy",
    name: "No kumo chaos — fault is in the TCP chaos proxy",
    description:
      "TCP chaos proxy (scripts/tcp-chaos-proxy.ts) sits between target " +
      "and kumo. Its connect-refuse rule drops a fraction of new TCP " +
      "connections before they reach kumo. Inspect /tcp-chaos/stats on " +
      "the proxy admin port (default :14567).",
    peakPhaseIndex: 0,
    phases: [{ label: "tcp-proxy-chaos", durationMs: 90_000, rules: [] }],
    healthCheck: async () => {
      try {
        const r = await fetch(opts.probeUrl, { method: "POST", signal: AbortSignal.timeout(15_000) });
        return { ok: r.ok, latencyMs: 0, errorRate: r.ok ? 0 : 1 };
      } catch {
        return { ok: false, latencyMs: 0, errorRate: 1 };
      }
    },
    acceptance: { errorRate: 0.05, consecutiveGreen: 5 },
  };
}

export function dnsStorm(opts: DnsStormOptions): Scenario {
  return {
    id: "dns-storm",
    chaosModelVersion: "fixed-v1",
    baselineFile: "server.dns-storm.ts",
    title: "OrderService intermittently can't reach DynamoDB; ECONNREFUSED",
    initialAlert:
      "[P1] OrderService: customer success rate 60%. Error rate climbing. " +
      "Errors are ECONNREFUSED / 'socket hang up' on DDB calls, not " +
      "AccessDenied / Throttling. kumo /kumo/chaos/rules: empty. kumo " +
      "itself is healthy (a direct curl to :4566/kumo/chaos/rules " +
      "returns 200). Something between the target and kumo is " +
      "refusing connections. On-call paged.",
    drill: noKumoChaosDrill(opts),
    groundTruth:
      "A TCP chaos proxy (scripts/tcp-chaos-proxy.ts) sits between the " +
      "target and kumo. The target's AWS_ENDPOINT_URL points at the " +
      "proxy (:14566), which normally forwards to kumo (:4566). A " +
      "`connect-refuse` rule installed at the proxy (probability=0.4) " +
      "destroys a fraction of new TCP connections before they reach " +
      "kumo. The SDK sees ECONNREFUSED at connect time. " +
      "Crucial detail: the failure is BEFORE the server. No server-side " +
      "state is touched. Idempotency tokens / read-after-write are " +
      "irrelevant here — the call never landed. " +
      "Mitigation lives in the SDK's connection management: " +
      "(a) bounded retry-with-backoff on connect-time errors " +
      "specifically (safe — no idempotency concern), " +
      "(b) socket reuse / keepalive (pooled sockets don't go " +
      "through connect each time, missing the chaos), " +
      "(c) failover to a different endpoint URL. " +
      "Observability: /tcp-chaos/stats on the proxy admin (:14567) " +
      "shows the matched count.",
    pages: [
      {
        atSec: 22,
        severity: "info",
        text:
          "Network team: 'tcpdump shows SYN going out from the target but " +
          "RST coming back immediately. Looks like it's not even reaching " +
          "kumo. Are we pointing at the right host?'",
      },
      {
        atSec: 55,
        severity: "warn",
        text:
          "Datadog: AWS_ENDPOINT_URL env var on the target is set to " +
          "http://localhost:14566, not :4566. That's a proxy port. " +
          "There's a tcp-chaos-proxy process running on :14566.",
      },
      {
        atSec: 95,
        severity: "info",
        text:
          "Platform colleague: 'Try curl http://localhost:14567/tcp-chaos/stats " +
          "to see whether the proxy is dropping connections. If matched > 0, " +
          "that\\'s your culprit.'",
      },
    ],
    redHerrings: [
      {
        hypothesis: "Looked at kumo chaos rules as the cause",
        matchKeyword: "(check|inspect|look).*(/kumo/chaos|kumo.*rules)",
      },
      {
        hypothesis: "Added idempotency tokens for the connect-refuse failures",
        matchKeyword: "(idempoten|ConditionExpression).*connect|connect.*(idempoten)",
      },
      {
        hypothesis: "Increased SDK maxAttempts without thinking about pool reuse",
        matchKeyword: "maxAttempts:\\s*\\d+",
      },
      {
        hypothesis: "Deleted the proxy chaos rule (cheating)",
        matchKeyword: "DELETE.*/tcp-chaos/rules",
      },
    ],
    idealPath: [
      "Check /kumo/chaos/rules — empty. Not a kumo problem.",
      "Notice AWS_ENDPOINT_URL points at :14566, a proxy",
      "Inspect /tcp-chaos/stats — see connect-refuse rule with matched > 0",
      "Hypothesize: connect-time chaos, not application-layer",
      "Mitigate: enable SDK socket reuse + bounded retry on ECONNREFUSED",
      "Verify /orders ≥ 80%",
    ],
    rubric: [
      investigatedBeforeEditing(3),
      readTargetSource(4),
      statedHypothesis(2),
      didNotAddRetries(2),
      minimalCodeChange(3, 3),
      recoveredSlo(3),
      ...(opts.customerUrl
        ? [customerImpactRecovered({ customerUrl: opts.customerUrl, weight: 5 })]
        : []),
      llmJudged({
        id: "mitigated-connect-level",
        weight: 6,
        description:
          "Mitigation targets the connect / socket-reuse layer (keepalive, bounded connect-time retry, endpoint failover), NOT idempotency / kumo / pool",
        question:
          "Given the agent's journal, transcript, and tool uses, did the " +
          "agent's mitigation target the CONNECTION LAYER (SDK socket " +
          "keepalive, bounded retry specifically on connect-time errors, " +
          "or endpoint failover)? Answer NO if the mitigation reached for " +
          "idempotency tokens (wrong layer — the call never landed), " +
          "kumo chaos endpoints (this isn't a kumo issue), or unbounded " +
          "SDK retries that compound the connect-refuse pressure.",
        regexFallback: (ctx) => {
          const text = (ctx.journalContents ?? []).join("\n") + "\n" + (ctx.transcript ?? "");
          return /(keep[\s-]*alive|socket.*reuse|httpAgent|connection[\s-]*pool|connect-time.*retry|failover|endpoint.*switch)/i.test(
            text,
          );
        },
      }),
    ],
  };
}
