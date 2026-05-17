/**
 * Replay of the 2021-12-07 AWS us-east-1 outage.
 *
 * Source: https://aws.amazon.com/message/12721/
 *
 * Real timeline (PST):
 *   07:30  Automated scaling triggers congestion on internal network devices
 *   07:33  EC2 APIs show elevated error rates / latency
 *   09:28  DNS remediation partially restores
 *   13:34  Significant congestion improvement
 *   14:22  Full network device recovery
 *   16:28  Services fully stabilized
 *
 * What makes this a good drill:
 *   - The published failure description is "control-plane impaired":
 *     EC2/Route53/STS/CloudWatch/IAM/Console login affected. Data plane
 *     was mostly fine. Many apps degraded because of *cold* dependencies
 *     (STS for assume-role during a deploy, IAM for instance-profile
 *     refresh, EC2 for autoscaling decisions).
 *   - AWS published that "a latent issue prevented clients from adequately
 *     backing off." This is the same anti-pattern PR #667 wants people to
 *     detect — and exactly what an AI rehearsal should teach.
 *   - Long onset-to-recovery (~7 hours of significant impact) but with a
 *     stair-step pattern, not monotonic recovery.
 *
 * AI is expected to discover:
 *   1. Data-plane requests still work; control-plane requests do not. Many
 *      apps couple them — find the coupling.
 *   2. STS assume-role calls happen *invisibly* via the AWS SDK credential
 *      provider chain. Caching credentials longer mitigates this.
 *   3. SDK retry backoff matters — uncapped retries during a control-plane
 *      outage drive call volume up exactly when AWS is shedding load.
 */
import type { Drill } from "../../orchestrator.ts";
import { compressTimeline } from "./_compress.ts";

export interface AWS20211207Options {
  probeUrl: string;
  durationMs?: number;
  acceptanceP99Ms?: number;
  acceptanceErrorRate?: number;
}

export function aws_2021_12_07_useast1(opts: AWS20211207Options): Drill {
  const total = opts.durationMs ?? 90_000;

  const phases = compressTimeline(
    [
      {
        // 07:30 → 09:28  congestion onset; control-plane impaired
        label: "network-congestion-onset",
        realMinutes: 118,
        rules: [
          {
            id: "sts-onset",
            enabled: true,
            match: { service: "sts" },
            inject: {
              kind: "awsError",
              probability: 0.4,
              awsError: { code: "ThrottlingException", httpStatus: 400 },
            },
          },
          {
            id: "ec2-onset",
            enabled: true,
            match: { service: "ec2" },
            inject: {
              kind: "awsError",
              probability: 0.3,
              awsError: { code: "RequestLimitExceeded", httpStatus: 503 },
            },
          },
          {
            id: "iam-onset",
            enabled: true,
            match: { service: "iam" },
            inject: {
              kind: "latency",
              probability: 1,
              latency: { p50Ms: 500, p95Ms: 3000, p99Ms: 8000, maxMs: 15000 },
            },
          },
          {
            id: "route53-onset",
            enabled: true,
            match: { service: "route53" },
            inject: {
              kind: "awsError",
              probability: 0.5,
              awsError: { code: "Throttling", httpStatus: 400 },
            },
          },
        ],
      },
      {
        // 09:28 → 13:34  DNS partial remediation; STS still degraded
        label: "partial-recovery-sts-still-down",
        realMinutes: 246,
        rules: [
          {
            id: "sts-peak",
            enabled: true,
            match: { service: "sts" },
            inject: {
              kind: "awsError",
              probability: 0.7,
              awsError: { code: "ThrottlingException", httpStatus: 400 },
            },
          },
          {
            id: "ec2-peak",
            enabled: true,
            match: { service: "ec2", action: "DescribeInstances" },
            inject: {
              kind: "latency",
              probability: 1,
              latency: { p50Ms: 800, p95Ms: 5000, p99Ms: 15000, maxMs: 25000 },
            },
          },
        ],
      },
      {
        // 13:34 → 14:22  congestion improves; tail latency only
        label: "congestion-clearing",
        realMinutes: 48,
        rules: [
          {
            id: "sts-tail",
            enabled: true,
            match: { service: "sts" },
            inject: {
              kind: "latency",
              probability: 1,
              latency: { p50Ms: 100, p95Ms: 800, p99Ms: 3000, maxMs: 6000 },
            },
          },
        ],
      },
      {
        // 14:22 → 16:28  long tail of "services stabilizing"
        label: "stabilizing-tail",
        realMinutes: 126,
        rules: [
          {
            id: "sts-residual",
            enabled: true,
            match: { service: "sts" },
            inject: {
              kind: "awsError",
              probability: 0.05,
              awsError: { code: "ThrottlingException", httpStatus: 400 },
            },
          },
        ],
      },
    ],
    total,
  );

  return {
    id: "aws-2021-12-07-useast1",
    name: "AWS 2021-12-07 us-east-1 (control-plane / network-device congestion, 7h)",
    description:
      "Replays the 2021 us-east-1 outage: STS/EC2/IAM/Route53 control-plane impaired, data plane fine. Clients failed to back off, amplifying.",
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
    const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(20_000) });
    ok = res.ok;
    errorRate = ok ? 0 : 1;
    detail = { status: res.status };
  } catch (err) {
    detail = { error: String(err) };
  }
  return { ok, latencyMs: performance.now() - t0, errorRate, detail };
}

const AI_BRIEF = `# Incident: AWS control-plane degraded (replay of 2021-12-07 us-east-1)

STS, EC2 control-plane (DescribeInstances), IAM and Route53 are all
returning throttling errors or hanging. Data-plane APIs (DDB GetItem,
S3 GetObject) appear fine.

Post-mortem:
  https://aws.amazon.com/message/12721/

What AWS explicitly called out: "a latent issue prevented clients from
adequately backing off." Uncapped retries during a control-plane outage
make the situation worse by adding to the load the network devices are
already struggling with.

Find what control-plane calls your app makes on the hot path. Common
hidden ones:
  - STS assume-role triggered by AWS SDK credential expiry
  - IAM instance-profile refresh
  - Route53 PrivateDNS resolution (some configurations)
  - EC2 metadata service (IMDSv2)

Acceptance: probe p99 < 2500ms AND error rate < 5% for 5 samples while
faults stay injected.

Watch out for:
  - SDK default credential provider chain: assumes role on every cold
    process. Cache the credential, refresh proactively.
  - Configure SDK retry mode = "adaptive" so it backs off when AWS
    signals overload, rather than "standard" with exponential retries.
`;
