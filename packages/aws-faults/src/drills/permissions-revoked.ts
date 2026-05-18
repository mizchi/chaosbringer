/**
 * Permissions-revoked drill.
 *
 * Models the recurring real-world pattern where an IAM policy change
 * (deploy, rotation, mass-edit script gone wrong) suddenly causes
 * production credentials to be rejected. The application has no way
 * to fix this from inside its process — the fix is out-of-band.
 *
 * Known recent examples:
 *   - 2018 — Reddit IAM mass-edit broke S3 access for many buckets
 *   - 2022 — GitLab Postgres role-rotation broke their app's read path
 *   - 2024 — multiple AWS customers reporting AccessDeniedException
 *     spikes after policy-as-code rollouts
 *
 * What this scenario tests: does the agent recognize that this is
 * NOT recoverable from app source? Real on-call who tries to "fix"
 * this by adding retries / circuit breakers / caches will fail; the
 * right action is graceful degradation + escalation, not SLO games.
 */
import type { Drill } from "../orchestrator.ts";

export interface PermissionsRevokedOptions {
  probeUrl: string;
  /** Probability of AccessDeniedException per call. Default 0.8. */
  probability?: number;
}

export function permissionsRevoked(opts: PermissionsRevokedOptions): Drill {
  const probability = opts.probability ?? 0.8;
  return {
    id: "permissions-revoked",
    name: "IAM AccessDeniedException — credentials suddenly rejected",
    description:
      `${(probability * 100).toFixed(0)}% of DDB calls return AccessDeniedException. ` +
      "An out-of-band IAM change has revoked the app's permissions. " +
      "Retries do not help. The right move is graceful degradation + escalation.",
    peakPhaseIndex: 0,
    phases: [
      {
        label: "iam-revoked",
        durationMs: 90_000,
        rules: [
          {
            id: "ddb-access-denied",
            enabled: true,
            match: { service: "dynamodb" },
            inject: {
              kind: "awsError",
              probability,
              awsError: {
                code: "AccessDeniedException",
                httpStatus: 400,
                message:
                  "User: arn:aws:iam::000000000000:role/orderservice is not " +
                  "authorized to perform: dynamodb:PutItem on resource. " +
                  "(Service: DynamoDB, Status Code: 400)",
              },
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
