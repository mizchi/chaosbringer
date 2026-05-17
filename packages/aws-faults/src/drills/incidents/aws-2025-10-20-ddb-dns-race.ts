/**
 * Replay of the 2025-10-19/20 AWS DynamoDB us-east-1 incident.
 *
 * Source: AWS Health Dashboard post-mortem, October 2025.
 *
 * Summary of the real incident:
 *   - A race condition in DynamoDB's DNS automation system caused
 *     an empty DNS record for dynamodb.us-east-1.amazonaws.com to be
 *     published, then partially propagate.
 *   - For ~15 hours, a fraction of clients could not resolve DDB's
 *     endpoint at all. Those that could often saw connections RST
 *     or timeouts because backend instances were also affected.
 *   - The blast radius extended through services that depended on
 *     DDB (Lambda, ECS task placement, IAM-internal state, etc.).
 *
 * What makes this a different chaos shape from our other drills:
 *
 *   - Existing drills inject *application-level* faults (HTTP 4xx/5xx
 *     with proper AWS envelope). SDKs handle these via the documented
 *     retry policy.
 *   - DNS-level + connection-level failure looks DIFFERENT to the SDK:
 *     no upstream-shaped error, just \`ENOTFOUND\` / \`ECONNRESET\` /
 *     timeouts. Different retry path, often with longer waits and
 *     less informative logging.
 *
 * We approximate this with \`Inject.kind = "disconnect"\` — kumo
 * hijacks the connection and closes it without writing a response.
 * The AWS SDK sees an unexpected EOF and retries through its
 * "transient network error" path. Latency mixed in so retries are
 * expensive.
 *
 * AI is expected to discover:
 *   1. The error pattern is \`ECONNRESET\` / \`socket hangup\` /
 *      \`UnknownError\`, NOT \`ProvisionedThroughputExceededException\`.
 *      Different retry shape.
 *   2. The SDK's default retry handles this but burns time per call.
 *      Connection pool may exhaust before retries complete.
 *   3. Mitigations: bound the per-call deadline (so retries don't
 *      pile up forever), add an outer circuit breaker that opens
 *      when the connection failure rate spikes, optionally fall back
 *      to a stale cache if one exists.
 */
import type { Drill } from "../../orchestrator.ts";
import { compressTimeline } from "./_compress.ts";

export interface AWS20251020Options {
  probeUrl: string;
  durationMs?: number;
}

export function aws_2025_10_20_ddb_dns_race(opts: AWS20251020Options): Drill {
  const total = opts.durationMs ?? 90_000;

  const phases = compressTimeline(
    [
      {
        // ~30min onset: some clients fail to resolve, intermittent
        label: "dns-onset-intermittent",
        realMinutes: 30,
        rules: [
          {
            id: "ddb-dns-intermittent",
            enabled: true,
            match: { service: "dynamodb" },
            inject: {
              kind: "disconnect",
              probability: 0.3,
              disconnect: { style: "hangup", afterMs: 0 },
            },
          },
        ],
      },
      {
        // ~14h peak: high disconnect rate + slow responses on the rest
        label: "dns-peak-most-clients-down",
        realMinutes: 14 * 60,
        rules: [
          {
            id: "ddb-dns-peak",
            enabled: true,
            match: { service: "dynamodb" },
            inject: {
              kind: "disconnect",
              probability: 0.7,
              disconnect: { style: "hangup", afterMs: 100 },
            },
          },
          // For the connections that DO complete, tail latency.
          {
            id: "ddb-dns-peak-latency",
            enabled: true,
            match: { service: "dynamodb" },
            inject: {
              kind: "latency",
              probability: 1,
              latency: { p50Ms: 200, p95Ms: 2000, p99Ms: 8000, maxMs: 15000 },
            },
          },
        ],
      },
      {
        // ~45min recovery: dns records propagating, low residual disconnect
        label: "dns-propagating",
        realMinutes: 45,
        rules: [
          {
            id: "ddb-dns-residual",
            enabled: true,
            match: { service: "dynamodb" },
            inject: {
              kind: "disconnect",
              probability: 0.1,
              disconnect: { style: "hangup", afterMs: 0 },
            },
          },
        ],
      },
    ],
    total,
  );

  return {
    id: "aws-2025-10-20-ddb-dns-race",
    peakPhaseIndex: 1, // the long peak is index 1
    name: "AWS 2025-10-20 DDB us-east-1 (DNS race — ~15h)",
    description:
      "Replays the 2025 DDB DNS race outage: connection-level failures, not service-level errors. SDKs see ECONNRESET-shaped behavior.",
    phases,
    healthCheck: () => probe(opts.probeUrl),
    acceptance: { errorRate: 0.05, consecutiveGreen: 5 },
    brief: AI_BRIEF,
  };
}

async function probe(url: string): Promise<import("../../orchestrator.ts").HealthCheckResult> {
  const t0 = performance.now();
  let ok = false;
  let detail: Record<string, unknown> | undefined;
  try {
    const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(20_000) });
    ok = res.ok;
    detail = { status: res.status };
  } catch (err) {
    detail = { error: String(err) };
  }
  return { ok, latencyMs: performance.now() - t0, errorRate: ok ? 0 : 1, detail };
}

const AI_BRIEF = `# Incident: DDB us-east-1 reachability (replay of 2025-10-20)

DynamoDB calls are failing intermittently with connection errors, not
service errors. Some requests time out, some get \`ECONNRESET\` /
"socket hangup" / "UnknownError". Different from a normal throttling
incident — the SDK's throttling-retry path doesn't apply here.

Real incident: a DNS automation race published an empty record for
\`dynamodb.us-east-1.amazonaws.com\`. ~15-hour outage with mixed
recovery as DNS propagated.

What good agents do:
  - Notice the error SHAPE is different: connection-level, not
    application-level. \`/kumo/chaos/stats\` shows \`disconnect\` rules
    firing, not \`throttle\` / \`awsError\`.
  - Bound the per-call deadline so a single hang doesn't tie up the
    connection pool.
  - Add a circuit breaker that opens on a burst of connection errors
    (not just per-call retries).
  - If possible, fall back to stale data or fail soft (e.g., serve
    cached order data from a local store).
`;
