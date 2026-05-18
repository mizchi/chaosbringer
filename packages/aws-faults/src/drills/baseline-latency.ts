/**
 * Baseline-latency drill — kumo returns within normal SLA.
 *
 * Used by client-side-bug scenarios (#119 Gap 4) where the failure is
 * NOT upstream. The chaos rule is a single low-latency injection that
 * any reasonable client would tolerate — p99 around 400ms, which is
 * well below typical production socket timeouts (5-30s) but above the
 * absurdly-tight 200-250ms timeouts some apps ship by accident.
 *
 * The point: when scoring runs, /kumo/chaos/stats SHOWS a rule firing,
 * but the rule is benign. If the agent reaches for "the upstream is
 * broken" hypothesis on the strength of this signal alone, they've
 * misread the room — the bug is on the client side.
 */
import type { Drill } from "../orchestrator.ts";

export interface BaselineLatencyOptions {
  probeUrl: string;
  /**
   * p99 latency in ms. Defaults to 400ms — high enough to expose
   * common client misconfigs (socketTimeout=200/250) but well within
   * normal production SLA budgets.
   */
  p99Ms?: number;
}

export function baselineLatency(opts: BaselineLatencyOptions): Drill {
  const p99 = opts.p99Ms ?? 400;
  return {
    id: "baseline-latency",
    name: "Normal background latency (no chaos)",
    description:
      `DDB calls take p50=80ms / p99=${p99}ms — boring background load. ` +
      "Any properly-configured client tolerates this. Surfaces only when " +
      "the client has a misconfig (e.g. socketTimeout below the p99).",
    peakPhaseIndex: 0,
    phases: [
      {
        label: "background",
        durationMs: 90_000,
        rules: [
          {
            id: "ddb-baseline-latency",
            enabled: true,
            match: { service: "dynamodb" },
            inject: {
              kind: "latency",
              probability: 1,
              latency: { p50Ms: 80, p95Ms: Math.floor(p99 * 0.85), p99Ms: p99, maxMs: Math.floor(p99 * 1.2) },
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
    const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(10_000) });
    ok = res.ok;
    detail = { status: res.status };
  } catch (err) {
    detail = { error: String(err) };
  }
  return { ok, latencyMs: performance.now() - t0, errorRate: ok ? 0 : 1, detail };
}
