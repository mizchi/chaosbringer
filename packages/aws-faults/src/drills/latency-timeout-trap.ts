/**
 * Latency-timeout trap drill.
 *
 * Used by the idempotency-violation scenario. Pure latency injection
 * (no throttle / no errors) with p99 above the target's per-call
 * timeout. Server-side completes; client-side times out. Apps with
 * non-idempotent retries leak ghost rows.
 */
import type { Drill } from "../orchestrator.ts";

export interface LatencyTimeoutTrapOptions {
  probeUrl: string;
}

export function latencyTimeoutTrap(opts: LatencyTimeoutTrapOptions): Drill {
  return {
    id: "latency-timeout-trap",
    name: "Latency with client-side timeout (idempotency trap)",
    description:
      "DDB PutItem with p99=2s latency. Targets with socketTimeout < 2s " +
      "see TimeoutError on the slow tail while the server-side write " +
      "still completes. Non-idempotent retries leak ghost rows.",
    peakPhaseIndex: 0,
    phases: [
      {
        label: "tail-latency",
        durationMs: 90_000,
        rules: [
          {
            id: "ddb-tail-latency-trap",
            enabled: true,
            match: { service: "dynamodb", action: "PutItem" },
            inject: {
              kind: "latency",
              probability: 1,
              latency: { p50Ms: 50, p95Ms: 1200, p99Ms: 2000, maxMs: 3000 },
            },
          },
        ],
      },
    ],
    healthCheck: () => probe(opts.probeUrl),
    acceptance: { errorRate: 0.05, consecutiveGreen: 5 },
  };
}

async function probe(url: string): Promise<import("../orchestrator.ts").HealthCheckResult> {
  const t0 = performance.now();
  let ok = false;
  let detail: Record<string, unknown> | undefined;
  try {
    const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(15_000) });
    ok = res.ok;
    detail = { status: res.status };
  } catch (err) {
    detail = { error: String(err) };
  }
  return { ok, latencyMs: performance.now() - t0, errorRate: ok ? 0 : 1, detail };
}
