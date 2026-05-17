/**
 * Replay of the 2017-02-28 S3 us-east-1 incident.
 *
 * Source: https://aws.amazon.com/message/41926/
 *
 * Real timeline (PST):
 *   09:37  Incorrect command removes more servers than intended; index
 *          subsystem capacity is lost. GET, LIST, PUT, DELETE all degraded.
 *   12:26  Index subsystem begins servicing GET, LIST, DELETE.
 *   13:18  Index subsystem fully recovered.
 *   13:54  Placement subsystem recovered; PUT (writes) normal.
 *   Total: ~4h17m
 *
 * What makes this a good drill:
 *   - Asymmetric recovery: reads come back before writes. Apps that
 *     conflated "S3 is up" with "S3 writes are up" had a second outage.
 *   - Many dependent services (EBS snapshots, EC2 launches, Lambda) silently
 *     break — the AI has to discover the dependency map.
 *   - The error response is generic 503 / InternalError, not anything
 *     S3-specific. SDK retry budgets are unbounded by default.
 *
 * AI is expected to discover:
 *   1. PUT and GET have different recovery curves; degrade the write path
 *      first (queue, defer to background).
 *   2. Other services (EBS, EC2 launch) are downstream of S3 — they
 *      recover only after S3 does.
 *   3. SDK default retries (with full jitter exponential backoff) can take
 *      5+ minutes per call when S3 is hard down — connection budget
 *      exhausts before backoff completes.
 */
import type { Drill } from "../../orchestrator.ts";
import { compressTimeline } from "./_compress.ts";

export interface AWS20170228Options {
  probeUrl: string;
  durationMs?: number;
  acceptanceP99Ms?: number;
  acceptanceErrorRate?: number;
}

export function aws_2017_02_28_s3(opts: AWS20170228Options): Drill {
  const total = opts.durationMs ?? 90_000;

  const phases = compressTimeline(
    [
      {
        // 09:37 → 12:26  near-total failure on all S3 ops (~2h49m)
        label: "index-down-all-ops-fail",
        realMinutes: 169,
        rules: [
          {
            id: "s3-index-down",
            enabled: true,
            match: { service: "s3" },
            inject: {
              kind: "awsError",
              probability: 0.95,
              awsError: { code: "InternalError", httpStatus: 500 },
            },
          },
          // Cascade: EBS snapshot ops blocked.
          {
            id: "ebs-snap-cascade",
            enabled: true,
            match: { service: "ec2", action: "CreateSnapshot" },
            inject: {
              kind: "awsError",
              probability: 0.7,
              awsError: { code: "InternalError", httpStatus: 500 },
            },
          },
        ],
      },
      {
        // 12:26 → 13:54  reads come back but writes still failing (~88min)
        label: "reads-back-writes-still-failing",
        realMinutes: 88,
        rules: [
          {
            id: "s3-writes-down",
            enabled: true,
            match: { service: "s3", action: "PutObject" },
            inject: {
              kind: "awsError",
              probability: 0.9,
              awsError: { code: "ServiceUnavailable", httpStatus: 503 },
            },
          },
          {
            id: "s3-multipart-down",
            enabled: true,
            match: { service: "s3", action: "CompleteMultipartUpload" },
            inject: {
              kind: "awsError",
              probability: 0.9,
              awsError: { code: "ServiceUnavailable", httpStatus: 503 },
            },
          },
          // Reads have tail latency from cold-cache.
          {
            id: "s3-reads-tail",
            enabled: true,
            match: { service: "s3", action: "GetObject" },
            inject: {
              kind: "latency",
              probability: 1,
              latency: { p50Ms: 80, p95Ms: 800, p99Ms: 3000, maxMs: 8000 },
            },
          },
        ],
      },
      {
        // 13:54 → 14:30  tail of slow writes during placement subsystem warm-up
        label: "writes-recovering-tail",
        realMinutes: 36,
        rules: [
          {
            id: "s3-writes-tail",
            enabled: true,
            match: { service: "s3", action: "PutObject" },
            inject: {
              kind: "latency",
              probability: 1,
              latency: { p50Ms: 100, p95Ms: 600, p99Ms: 2000, maxMs: 4000 },
            },
          },
        ],
      },
    ],
    total,
  );

  return {
    id: "aws-2017-02-28-s3",
    name: "AWS 2017-02-28 S3 us-east-1 (index subsystem outage, asymmetric recovery)",
    description:
      "Replays the 2017 S3 us-east-1 incident: 3-phase asymmetric outage where reads recover before writes. EBS snapshots cascade.",
    phases,
    healthCheck: () => probe(opts.probeUrl),
    acceptance: {
      p99Ms: opts.acceptanceP99Ms ?? 3_000,
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

const AI_BRIEF = `# Incident: S3 index subsystem down (replay of 2017-02-28 us-east-1)

S3 is returning 5xx on virtually all operations. Some EC2 snapshot calls
are also failing. Replay of the real incident at:
  https://aws.amazon.com/message/41926/

This outage has THREE distinct phases. Reads will come back BEFORE writes
do. Don't assume "S3 is up" the moment any one operation starts succeeding.

Total real-world duration was ~4h17m. In this drill it is compressed but
the shape is preserved.

Acceptance: probe p99 < 3000ms AND error rate < 5% for 5 consecutive
samples while faults are still active.

Watch out for:
  - SDK default retry policy with full-jitter exponential backoff can take
    5+ minutes per call. Your connection pool will exhaust first.
  - If your write path is synchronous in the request handler, the user
    sees that 5-minute hang. Defer writes to a queue.
  - The blast radius spreads via shared dependencies (EBS snapshots, EC2
    launches that need to read AMIs from S3). Discover the graph.
`;
