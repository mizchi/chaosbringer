/**
 * Byzantine silent-loss drill.
 *
 * Injects `silentSuccess` chaos on DynamoDB PutItem: 40% of writes
 * return 200 OK from kumo WITHOUT invoking the real handler. The
 * target sees success and increments its writesAcked counter, but
 * no row is actually persisted in DDB.
 *
 * Requires kumo with the silent-success inject kind (see
 * kumo-chaos-patch/internal/chaos/awserrors.go WriteSilentSuccess).
 */
import type { Drill } from "../orchestrator.ts";

export interface ByzantineSilentLossOptions {
  probeUrl: string;
  /** Probability per PutItem of silently swallowing. Default 0.4. */
  probability?: number;
}

export function byzantineSilentLoss(opts: ByzantineSilentLossOptions): Drill {
  const probability = opts.probability ?? 0.4;
  return {
    id: "byzantine-silent-loss",
    name: "Byzantine: DDB PutItem returns 200 without persisting",
    description:
      `${(probability * 100).toFixed(0)}% of PutItem calls return 200 OK ` +
      "without the real handler running. /orders looks healthy; the data " +
      "isn't there. Probe-success ≠ state correctness.",
    peakPhaseIndex: 0,
    phases: [
      {
        label: "byzantine-loss",
        durationMs: 90_000,
        rules: [
          {
            id: "ddb-byzantine-put",
            enabled: true,
            match: { service: "dynamodb", action: "PutItem" },
            inject: {
              kind: "silentSuccess",
              probability,
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
    const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(5_000) });
    ok = res.ok;
    detail = { status: res.status };
  } catch (err) {
    detail = { error: String(err) };
  }
  return { ok, latencyMs: performance.now() - t0, errorRate: ok ? 0 : 1, detail };
}
