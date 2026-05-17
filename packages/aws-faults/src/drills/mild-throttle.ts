/**
 * Mild-throttle drill — chaos exists but is within acceptance.
 *
 * Used by the restart-causes-worse-failure scenario. The chaos is
 * deliberately MILD so customer SLO is already met. Tests whether
 * the agent recognizes "chaos visible in stats" doesn't always
 * mean "customer is suffering."
 */
import type { Drill } from "../orchestrator.ts";

export interface MildThrottleOptions {
  probeUrl: string;
}

export function mildThrottle(opts: MildThrottleOptions): Drill {
  return {
    id: "mild-throttle",
    name: "Mild DDB throttle (within SLO)",
    description:
      "5% PutItem throttle. SDK default retries (3 attempts) absorb it. " +
      "Customer success rate stays at 99.99%.",
    peakPhaseIndex: 0,
    phases: [
      {
        label: "mild-noise",
        durationMs: 90_000,
        rules: [
          {
            id: "ddb-mild-throttle",
            enabled: true,
            match: { service: "dynamodb", action: "PutItem" },
            inject: {
              kind: "throttle",
              probability: 0.05,
              awsError: { code: "ProvisionedThroughputExceededException" },
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
    const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(20_000) });
    ok = res.ok;
    detail = { status: res.status };
  } catch (err) {
    detail = { error: String(err) };
  }
  return { ok, latencyMs: performance.now() - t0, errorRate: ok ? 0 : 1, detail };
}
