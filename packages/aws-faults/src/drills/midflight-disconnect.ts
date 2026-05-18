/**
 * Mid-flight disconnect drill (#119 Gap 3).
 *
 * kumo's existing `disconnect` inject can hangup at three positions:
 *   - afterMs: 0    — refuse the connection ("DNS race"-style)
 *   - afterMs: ~100 — connect succeeds, RST right after headers
 *   - afterMs: ~500 — connection lives long enough that the body is
 *                     partially written before tear-down
 *
 * The existing ddb-dns-race scenario uses afterMs=0/100 (connect-time
 * failures). This drill installs afterMs=300 — the connection is
 * established, the SDK has already sent its request body, and the
 * server has begun processing — then RST mid-response. The client
 * can't tell whether the call landed:
 *   - PutItem may have committed before the RST
 *   - The error shape is generic (socket hangup), not a structured
 *     AWS error
 *
 * This is a Byzantine-shaped network fault: the agent must reason
 * about idempotency and partial application of side effects.
 */
import type { Drill } from "../orchestrator.ts";

export interface MidflightDisconnectOptions {
  probeUrl: string;
  /** Probability of a mid-flight RST per matched request. Default 0.25. */
  probability?: number;
  /** Milliseconds after request receipt before kumo tears down. Default 300. */
  afterMs?: number;
}

export function midflightDisconnect(opts: MidflightDisconnectOptions): Drill {
  const probability = opts.probability ?? 0.25;
  const afterMs = opts.afterMs ?? 300;
  return {
    id: "midflight-disconnect",
    name: "Mid-flight connection tear-down on DDB PutItem",
    description:
      `${(probability * 100).toFixed(0)}% of PutItem calls connect successfully ` +
      `then receive an unexpected EOF ${afterMs}ms in. The write may or may not ` +
      `have committed before the tear-down — the client has no way to tell from ` +
      `the response (or lack thereof).`,
    peakPhaseIndex: 0,
    phases: [
      {
        label: "midflight-rst",
        durationMs: 90_000,
        rules: [
          {
            id: "ddb-midflight-rst",
            enabled: true,
            match: { service: "dynamodb", action: "PutItem" },
            inject: {
              kind: "disconnect",
              probability,
              disconnect: { style: "hangup", afterMs },
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
