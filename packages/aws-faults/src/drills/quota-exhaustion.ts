/**
 * Soft-quota exhaustion drill.
 *
 * Not a single AWS post-mortem replay — a synthesis of the recurring
 * "soft limit hit" pattern. Inspired by Google's 2020-12-14 auth
 * outage (quota system propagation failure brought down login for
 * 45 minutes) and the family of AWS quota-exceeded incidents that
 * customers see when traffic moves between regions or accounts.
 *
 * What makes this a different shape from throttling:
 *
 *   - Throttling (PEx, Throttling) is per-request; backing off + retry
 *     eventually wins because the next-attempt-token-bucket fills.
 *   - Soft quota (LimitExceededException, ServiceQuotaExceededException)
 *     is per-account-per-second. Backing off doesn't help on its own —
 *     you can't ask for more than the quota allows until either you
 *     request an increase OR you decrease your call rate.
 *
 * SDK retry behavior differs too: throttling is classified as
 * "retryable.throttling" with a fast-jitter backoff; quota errors
 * are often classified "retryable.client" with a longer backoff,
 * or in some SDK versions are NOT retried at all (the caller has to
 * implement the wait).
 *
 * Agents that confuse these two will:
 *   - Add aggressive retries (no help — burns quota harder)
 *   - Decouple a non-critical path (irrelevant — quota is account-wide)
 *
 * Correct mitigations:
 *   - Reduce request rate (the easiest immediate action)
 *   - Batch requests (Multi-Get / BatchGet instead of N GetItems)
 *   - Cache the response (no need to call if you can answer locally)
 *
 * Single-phase drill, no feedback, fixed probability.
 */
import type { Drill } from "../orchestrator.ts";

export interface QuotaExhaustionOptions {
  probeUrl: string;
  /** Probability per call of returning LimitExceededException. Default 0.6. */
  probability?: number;
}

export function quotaExhaustion(opts: QuotaExhaustionOptions): Drill {
  const probability = opts.probability ?? 0.6;

  return {
    id: "quota-exhaustion",
    name: "Soft account-level quota exhaustion",
    description:
      `Inject ${(probability * 100).toFixed(0)}% LimitExceededException on dynamodb. ` +
      "Soft quota — not transient throttling; retries do not help.",
    peakPhaseIndex: 0,
    phases: [
      {
        label: "quota-saturated",
        durationMs: 90_000,
        rules: [
          {
            id: "ddb-quota-saturated",
            enabled: true,
            match: { service: "dynamodb" },
            inject: {
              kind: "awsError",
              probability,
              awsError: {
                code: "LimitExceededException",
                httpStatus: 400,
                message:
                  "Account-level read/write request rate exceeded the configured " +
                  "soft limit. Request a quota increase or reduce traffic to recover.",
              },
            },
          },
        ],
      },
    ],
    healthCheck: () => probe(opts.probeUrl),
    acceptance: { errorRate: 0.05, consecutiveGreen: 5 },
    brief: AI_BRIEF,
  };
}

async function probe(url: string): Promise<import("../orchestrator.ts").HealthCheckResult> {
  const t0 = performance.now();
  let ok = false;
  let detail: Record<string, unknown> | undefined;
  try {
    const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(5_000) });
    ok = res.ok;
    detail = { status: res.status };
  } catch (err) {
    detail = { error: String(err) };
  }
  return { ok, latencyMs: performance.now() - t0, errorRate: ok ? 0 : 1, detail };
}

const AI_BRIEF = `# Incident: account-level soft-quota exhaustion

Production writes are failing with \`LimitExceededException\`. This is
NOT \`ProvisionedThroughputExceededException\` (per-table throttling) —
it's an account-level quota. Adding retries doesn't help because the
quota refills on a much longer timescale than retries.

Mitigations that work:
  - Reduce call rate (batch, cache, throttle yourself)
  - Request a quota increase out-of-band
Mitigations that don't:
  - More retries
  - Switching regions (the quota is global-account in many cases)

Acceptance: customer SLO above the threshold while the chaos is still firing.
`;
