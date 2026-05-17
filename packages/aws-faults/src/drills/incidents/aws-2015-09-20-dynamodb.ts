/**
 * Replay of the 2015-09-20 DynamoDB us-east-1 incident.
 *
 * Source: https://aws.amazon.com/message/5467D2/
 *
 * Real timeline (PDT):
 *   02:19  Initial network disruption triggers metadata renewal storms
 *   02:37  Error rate peaks at ~55%
 *   05:06  AWS pauses metadata service requests to reduce retry load
 *   07:10  DynamoDB restored to operational error rates
 *   07:29  CloudWatch fully recovered
 *   10:52  Auto Scaling backlog cleared
 *
 * What makes this incident a good drill:
 *   - The peak error rate is published verbatim ("approximately 55%"), so
 *     the reproduction has a hard, factual target — not a guess.
 *   - Retries amplified the failure: "Unavailable servers continued to retry
 *     requests for membership data, maintaining high load on the metadata
 *     service." Any AI recovery that adds *more* retries makes it worse —
 *     the correct response is to cap or shed.
 *   - Cascade to SQS / CloudWatch / Auto Scaling is well documented. We
 *     install secondary rules so the AI can also discover "DDB is the
 *     upstream — these other 5xx are just symptoms."
 *
 * AI is expected to discover:
 *   1. DynamoDB throttling is the upstream cause; SQS/CloudWatch faults are
 *      symptoms of shared metadata service backend.
 *   2. Reducing — not increasing — SDK retry attempts shortens recovery.
 *   3. A circuit breaker on the DDB write path bounds the blast radius.
 */
import type { Drill } from "../../orchestrator.ts";
import { compressTimeline } from "./_compress.ts";

export interface AWS20150920Options {
  probeUrl: string;
  /** Total drill duration. Default 90s. Real incident was ~5 hours. */
  durationMs?: number;
  acceptanceP99Ms?: number;
  acceptanceErrorRate?: number;
}

export function aws_2015_09_20_dynamodb(opts: AWS20150920Options): Drill {
  const total = opts.durationMs ?? 90_000;

  const phases = compressTimeline(
    [
      {
        // 02:19 → 02:37 onset: metadata storms ramping
        label: "onset-metadata-storm",
        realMinutes: 18,
        rules: [
          {
            id: "ddb-onset",
            enabled: true,
            match: { service: "dynamodb" },
            inject: {
              kind: "throttle",
              probability: 0.15,
              awsError: { code: "ProvisionedThroughputExceededException" },
            },
          },
        ],
      },
      {
        // 02:37 → 05:06 peak: published 55% error rate
        label: "peak-55pct-errors",
        realMinutes: 149,
        rules: [
          {
            id: "ddb-peak",
            enabled: true,
            match: { service: "dynamodb" },
            inject: {
              kind: "throttle",
              probability: 0.55,
              awsError: { code: "ProvisionedThroughputExceededException" },
              // Retry-storm feedback (added 2026-05-17 v3.1): when match rate
              // in the last 1s exceeds 20, each excess match raises throttle
              // probability by 0.5% up to 95% cap. An agent that "fixes" the
              // outage by adding more retries drives match rate up, which
              // drives probability up — exactly the 2015 feedback loop. The
              // mitigation that wins is one that REDUCES request rate (cap
              // retries, circuit breaker, queue), not amplifies it.
              feedback: {
                windowMs: 1000,
                threshold: 20,
                probabilityStep: 0.005,
                maxProbability: 0.95,
              },
            },
          },
          // Without latency, SDK default retries absorb the 55% throttle
          // entirely and the customer never sees the failure. The real
          // 2015 incident's customer-visible 55% came from throttling +
          // slowed metadata responses. See docs/recipes/evaluation-2026-05-17.md.
          {
            id: "ddb-peak-tail-latency",
            enabled: true,
            match: { service: "dynamodb" },
            inject: {
              kind: "latency",
              probability: 1,
              latency: { p50Ms: 50, p95Ms: 500, p99Ms: 2000, maxMs: 5000 },
              // Same feedback shape as the throttle rule, applied to latency:
              // every excess match multiplies latency by 1.05 up to 5x.
              feedback: {
                windowMs: 1000,
                threshold: 20,
                latencyMultStep: 0.05,
                maxLatencyMult: 5,
              },
            },
          },
          // Cascade: SQS metadata also affected.
          {
            id: "sqs-cascade",
            enabled: true,
            match: { service: "sqs" },
            inject: {
              kind: "awsError",
              probability: 0.2,
              awsError: { code: "ServiceUnavailableException", httpStatus: 503 },
            },
          },
          // Cascade: CloudWatch PutMetricData affected.
          {
            id: "cw-cascade",
            enabled: true,
            match: { service: "monitoring", action: "PutMetricData" },
            inject: {
              kind: "awsError",
              probability: 0.3,
              awsError: { code: "InternalServerError", httpStatus: 500 },
            },
          },
        ],
      },
      {
        // 05:06 → 07:10 metadata pauses: probability shrinking but tail latency lingers
        label: "metadata-paused-recovering",
        realMinutes: 124,
        rules: [
          {
            id: "ddb-recovering",
            enabled: true,
            match: { service: "dynamodb" },
            inject: {
              kind: "throttle",
              probability: 0.15,
              awsError: { code: "ProvisionedThroughputExceededException" },
            },
          },
          {
            id: "ddb-tail-latency",
            enabled: true,
            match: { service: "dynamodb" },
            inject: {
              kind: "latency",
              probability: 1,
              latency: { p50Ms: 30, p95Ms: 400, p99Ms: 2000, maxMs: 5000 },
            },
          },
        ],
      },
      {
        // 07:10 → 10:52 tail: low residual + Auto Scaling backlog
        label: "tail-autoscaling-backlog",
        realMinutes: 222,
        rules: [
          {
            id: "ddb-residual",
            enabled: true,
            match: { service: "dynamodb" },
            inject: {
              kind: "throttle",
              probability: 0.05,
              awsError: { code: "ProvisionedThroughputExceededException" },
            },
          },
        ],
      },
    ],
    total,
  );

  return {
    id: "aws-2015-09-20-dynamodb",
    name: "AWS 2015-09-20 DynamoDB us-east-1 (metadata service / retry storm)",
    description:
      "Replays the 2015 DynamoDB us-east-1 incident: 4-phase timeline with 55% error peak + cascading SQS/CloudWatch faults. Retries amplified the original outage.",
    phases,
    healthCheck: () => probe(opts.probeUrl),
    acceptance: {
      p99Ms: opts.acceptanceP99Ms ?? 2_000,
      errorRate: opts.acceptanceErrorRate ?? 0.05,
      consecutiveGreen: 5,
    },
    brief: AI_BRIEF,
  };
}

async function probe(url: string): Promise<import("../../orchestrator.ts").HealthCheckResult> {
  const t0 = performance.now();
  let ok = false;
  let errorRate = 1;
  let detail: Record<string, unknown> | undefined;
  try {
    const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(10_000) });
    ok = res.ok;
    errorRate = ok ? 0 : 1;
    detail = { status: res.status };
  } catch (err) {
    detail = { error: String(err) };
  }
  return { ok, latencyMs: performance.now() - t0, errorRate, detail };
}

const AI_BRIEF = `# Incident: DynamoDB metadata-service overload (replay of 2015-09-20 us-east-1)

You are on-call. Production writes to DynamoDB are returning a high rate of
\`ProvisionedThroughputExceededException\`. Some SQS and CloudWatch
PutMetricData calls are also intermittently failing — this is unusual.

Post-mortem (real incident this replay is based on):
  https://aws.amazon.com/message/5467D2/

The real outage at AWS lasted ~5 hours with a published peak error rate of
~55%. Retries amplified the failure: clients hammering the metadata service
slowed it further. AWS eventually mitigated by *pausing* metadata service
requests, not by adding capacity.

You have shell access. Target app source is in ./target. AWS endpoint is
\`http://localhost:4566\` (a patched kumo). Logs at /tmp/target.log.

Acceptance: probe p99 < 2000ms AND error rate < 5% sustained for 5
consecutive samples, while the underlying faults are STILL being injected.

Suggested investigation:
  1. Notice that DDB is the upstream — the SQS/CW faults are symptoms,
     not independent incidents.
  2. Check what retry policy the app's SDK clients are using.
  3. Consider: do MORE retries help, or hurt, here?
  4. Bound the blast radius: circuit breaker on the DDB write, fall back
     to a queue, or shed load by failing fast.
`;
