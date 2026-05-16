import type { Rule } from "../types.ts";
import type { Drill, HealthCheckResult } from "../orchestrator.ts";

export interface DDBThrottleStormOptions {
  /** Target app health probe URL. Must drive at least one DynamoDB call. */
  probeUrl: string;
  /** AWS API action to throttle. Default: PutItem. */
  action?: string;
  /** Throttle probability per request. Default: 0.5. */
  probability?: number;
  /** Optional: also inject latency to simulate retry-amplified tail. */
  additionalLatencyMs?: number;
  /** Acceptance: p99 must drop back below this. Default: 1500ms. */
  acceptanceP99Ms?: number;
  /** Acceptance: error rate must drop back below this. Default: 0.02. */
  acceptanceErrorRate?: number;
}

/**
 * "DynamoDB throttling + retry storm" drill.
 *
 * Why this drill: the most common production failure for DDB-backed apps is
 * a hot-partition or burst-capacity event that returns
 * ProvisionedThroughputExceededException on a fraction of writes. AWS SDKs
 * retry these with exponential backoff — but when the throttling rate is
 * high enough, retries themselves drive the throughput requirement up,
 * making the problem worse (the "retry storm").
 *
 * What the AI should learn to do:
 *   - Detect the failure pattern from app logs / metrics
 *   - Choose a mitigation: reduce write rate, switch to on-demand capacity,
 *     widen the partition key, add a circuit breaker, or add a queue
 *   - Verify the mitigation by watching probe SLO return to baseline
 *
 * The drill leaves chaos rules installed during the recovery phase: the AI
 * cannot "wait it out". A mitigation must actually neutralize the failure
 * mode while it is still being injected.
 */
export function ddbThrottleStorm(opts: DDBThrottleStormOptions): Drill {
  const probability = opts.probability ?? 0.5;
  const action = opts.action ?? "PutItem";

  const rules: Rule[] = [
    {
      id: "ddb-throttle-storm",
      enabled: true,
      match: { service: "dynamodb", action },
      inject: {
        kind: "throttle",
        probability,
        awsError: { code: "ProvisionedThroughputExceededException" },
      },
    },
  ];

  if (opts.additionalLatencyMs && opts.additionalLatencyMs > 0) {
    rules.push({
      id: "ddb-throttle-storm-latency",
      enabled: true,
      match: { service: "dynamodb", action },
      inject: {
        kind: "latency",
        probability: 1.0,
        latency: { fixedMs: opts.additionalLatencyMs },
      },
    });
  }

  const probeUrl = opts.probeUrl;

  return {
    id: "ddb-throttle-storm",
    name: "DynamoDB throttling + retry storm",
    description:
      `Inject ${(probability * 100).toFixed(0)}% ProvisionedThroughputExceededException on dynamodb:${action}.`,
    rules,
    acceptance: {
      p99Ms: opts.acceptanceP99Ms ?? 1500,
      errorRate: opts.acceptanceErrorRate ?? 0.02,
      consecutiveGreen: 5,
    },
    healthCheck: () => probe(probeUrl),
    brief: AI_BRIEF,
  };
}

async function probe(url: string): Promise<HealthCheckResult> {
  const t0 = performance.now();
  let ok = false;
  let errorRate = 1;
  let detail: Record<string, unknown> | undefined;
  try {
    const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(5_000) });
    ok = res.ok;
    errorRate = ok ? 0 : 1;
    detail = { status: res.status };
  } catch (err) {
    detail = { error: String(err) };
  }
  return { ok, latencyMs: performance.now() - t0, errorRate, detail };
}

const AI_BRIEF = `# Incident: DynamoDB ProvisionedThroughputExceededException

Production writes to DynamoDB are returning ProvisionedThroughputExceededException on
a significant fraction of requests. The probe at \`POST /health\` (which exercises
the write path) is failing.

You have shell access. The target app source lives in \`./target\`. AWS calls
go through kumo at \`http://localhost:4566\` (AWS_ENDPOINT_URL is set in env).

Acceptance: probe p99 latency must drop below 1500ms AND error rate below 2%
sustained for 5 consecutive samples, while the underlying AWS faults are STILL
being injected (you cannot fix this by waiting).

Suggested investigation order:
  1. Read the target app source to understand the write path
  2. Run \`curl -s http://localhost:4566/kumo/chaos/stats\` to see what kumo
     is injecting
  3. Tail the app log (\`tail -f /tmp/target.log\`) to see SDK retry behavior
  4. Patch the app and restart it (the orchestrator will keep probing)

Hints on what works (in rough order of effort):
  - Add a circuit breaker on the DDB write path
  - Cap SDK retry attempts (currently default 3+ exponential)
  - Add a small request-coalescing buffer in front of the writer
`;
