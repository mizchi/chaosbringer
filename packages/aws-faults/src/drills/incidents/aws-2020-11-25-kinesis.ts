/**
 * Replay of the 2020-11-25 Kinesis us-east-1 incident.
 *
 * Source: https://aws.amazon.com/message/11201/
 *
 * Real timeline (PST):
 *   05:15  First alarms; PutRecord/GetRecord errors begin
 *   07:51  Root cause narrowed (OS thread limit exhausted on front-end fleet)
 *   09:39  Root cause confirmed
 *   10:07  Front-end server restart begins
 *   22:23  Kinesis fully recovered  (17+ hours)
 *
 * What makes this a good drill:
 *   - LONG sustained outage (~17h) with multiple cascading services. Tests
 *     whether the AI's mitigation holds up over time, not just at the peak.
 *   - Many people learned about this incident by way of Cognito failing —
 *     "we can't log in." The Kinesis dependency was *invisible* from the
 *     app's perspective. Discovery of the actual upstream is the lesson.
 *   - Cognito had a "latent bug in buffering code where webservers blocked
 *     on backlogged Kinesis buffers" — exactly the kind of thread-blocked
 *     cascade a chaos drill should make obvious.
 *
 * AI is expected to discover:
 *   1. The probe failure is downstream of Kinesis, not the obvious service.
 *   2. Front-end thread-pool bounded resources fill up if every blocked
 *      request holds a thread waiting for Kinesis to retry-loop.
 *   3. Mitigation = drop / async / circuit-break on the Kinesis dependency,
 *      NOT scale up the front-end.
 */
import type { Drill } from "../../orchestrator.ts";
import { compressTimeline } from "./_compress.ts";

export interface AWS20201125Options {
  probeUrl: string;
  durationMs?: number;
  acceptanceP99Ms?: number;
  acceptanceErrorRate?: number;
}

export function aws_2020_11_25_kinesis(opts: AWS20201125Options): Drill {
  const total = opts.durationMs ?? 90_000;

  const phases = compressTimeline(
    [
      {
        // 05:15 → 07:51  early errors, ramping
        label: "early-errors",
        realMinutes: 156,
        rules: [
          {
            id: "kinesis-early",
            enabled: true,
            match: { service: "kinesis" },
            inject: {
              kind: "awsError",
              probability: 0.4,
              awsError: { code: "InternalFailure", httpStatus: 500 },
            },
          },
        ],
      },
      {
        // 07:51 → 10:07  peak: most front-end calls failing or hanging
        label: "thread-pool-exhausted",
        realMinutes: 136,
        rules: [
          // Some requests return errors immediately.
          {
            id: "kinesis-peak-error",
            enabled: true,
            match: { service: "kinesis" },
            inject: {
              kind: "awsError",
              probability: 0.6,
              awsError: { code: "InternalFailure", httpStatus: 500 },
            },
          },
          // The rest hang — modeling the thread-blocked behavior of the
          // front-end fleet. AWS SDKs see this as a long-pending request,
          // not an immediate error.
          {
            id: "kinesis-peak-hang",
            enabled: true,
            match: { service: "kinesis" },
            inject: {
              kind: "latency",
              probability: 1,
              latency: { p50Ms: 500, p95Ms: 4000, p99Ms: 10000, maxMs: 20000 },
            },
          },
          // Cascade: Cognito auth fails (real incident).
          {
            id: "cognito-cascade",
            enabled: true,
            match: { service: "cognito-idp" },
            inject: {
              kind: "awsError",
              probability: 0.5,
              awsError: { code: "InternalErrorException", httpStatus: 500 },
            },
          },
          // Cascade: CloudWatch PutMetricData backed up.
          {
            id: "cw-metrics-cascade",
            enabled: true,
            match: { service: "monitoring", action: "PutMetricData" },
            inject: {
              kind: "latency",
              probability: 1,
              latency: { p50Ms: 300, p95Ms: 2000, p99Ms: 5000, maxMs: 8000 },
            },
          },
        ],
      },
      {
        // 10:07 → 22:23  long slow drain as front-end restarts
        label: "slow-drain",
        realMinutes: 736,
        rules: [
          {
            id: "kinesis-drain-error",
            enabled: true,
            match: { service: "kinesis" },
            inject: {
              kind: "awsError",
              probability: 0.15,
              awsError: { code: "InternalFailure", httpStatus: 500 },
            },
          },
          {
            id: "kinesis-drain-latency",
            enabled: true,
            match: { service: "kinesis" },
            inject: {
              kind: "latency",
              probability: 1,
              latency: { p50Ms: 100, p95Ms: 800, p99Ms: 3000, maxMs: 6000 },
            },
          },
        ],
      },
    ],
    total,
  );

  return {
    id: "aws-2020-11-25-kinesis",
    peakPhaseIndex: 1, // "thread-pool-exhausted" is index 1.
    name: "AWS 2020-11-25 Kinesis us-east-1 (thread-limit exhaustion, 17h)",
    description:
      "Replays the 2020 Kinesis us-east-1 incident: thread pool exhaustion on front-end fleet, Cognito and CloudWatch metrics cascade, very long slow-drain recovery.",
    phases,
    healthCheck: () => probe(opts.probeUrl),
    acceptance: {
      p99Ms: opts.acceptanceP99Ms ?? 2_500,
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
    const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(15_000) });
    ok = res.ok;
    errorRate = ok ? 0 : 1;
    detail = { status: res.status };
  } catch (err) {
    detail = { error: String(err) };
  }
  return { ok, latencyMs: performance.now() - t0, errorRate, detail };
}

const AI_BRIEF = `# Incident: invisible Kinesis dependency (replay of 2020-11-25 us-east-1)

Production probes are failing. Users reporting login issues (Cognito).
CloudWatch metrics look delayed. None of these are the actual problem.

Post-mortem of the real incident:
  https://aws.amazon.com/message/11201/

The 2020 outage was caused by OS thread-limit exhaustion on the Kinesis
front-end fleet. Kinesis itself was the root, but the user-visible symptoms
were "login broken" and "metrics missing" because so many services have a
hidden buffered write to Kinesis.

Your app probably has the same hidden dependency. Find it. Mitigate it.

Acceptance: probe p99 < 2500ms AND error rate < 5% for 5 consecutive
samples while faults stay injected.

Watch out for:
  - Scaling up the front-end DOES NOT HELP — the failure is in a downstream
    pool. Adding callers just fills the pool faster.
  - Each blocked thread holds resources. A 10s timeout on a high-RPS path
    means many threads stuck waiting.
  - A buffered async write (fire-and-forget into a local queue with bounded
    size + drop-policy) is usually the right shape.
`;
