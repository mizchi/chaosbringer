/**
 * Scenario: pgbouncer-style shared multiplexer overload.
 *
 * Different from pg-pool-exhaustion (local pool is the bottleneck)
 * — here the local pool has plenty of capacity, but a shared
 * multiplexer in front of it caps total concurrent queries hard.
 * The agent must recognize the asymmetry from observability:
 * bouncer.queued is high, pool.waitingCount is zero.
 *
 * Real-world: pgbouncer max_client_conn / default_pool_size is too
 * low for the deployed fleet; one heavy service starves the rest;
 * scaling out application instances doesn't help because they all
 * share the same bouncer.
 *
 * Correct mitigations:
 *   - Raise the bouncer cap (production: max_client_conn /
 *     default_pool_size).
 *   - Shard the bouncer per-tenant / per-service.
 *   - Drop the bouncer if the database can handle direct
 *     connections.
 */
import type { Scenario } from "../types.ts";
import { customerImpactRecovered, didNotAddRetries, investigatedBeforeEditing, minimalCodeChange, readTargetSource, recoveredSlo, statedHypothesis } from "../scoring.ts";
import { llmJudged } from "../scoring-llm.ts";
import type { Drill } from "../../orchestrator.ts";

export interface PgBouncerOverloadOptions { probeUrl: string; customerUrl?: string; durationMs?: number; }

function noKumoChaosDrill(opts: PgBouncerOverloadOptions): Drill {
  return {
    id: "no-kumo-chaos-bouncer-overload", name: "No kumo chaos — shared pg-bouncer cap in target",
    description: "Target serializes all pg queries on a max=3 in-process semaphore in front of the actual Pool (max=20). Customer queues on the bouncer; pool stays idle.",
    peakPhaseIndex: 0, phases: [{ label: "in-process-bouncer-overload", durationMs: 90_000, rules: [] }],
    healthCheck: async () => { try { const r = await fetch(opts.probeUrl, { method: "POST", signal: AbortSignal.timeout(15_000) }); return { ok: r.ok, latencyMs: 0, errorRate: r.ok ? 0 : 1 }; } catch { return { ok: false, latencyMs: 0, errorRate: 1 }; } },
    acceptance: { errorRate: 0.05, consecutiveGreen: 5 },
  };
}

export function pgBouncerOverload(opts: PgBouncerOverloadOptions): Scenario {
  return {
    id: "pg-bouncer-overload",
    chaosModelVersion: "fixed-v1",
    baselineFile: "server.pg-shared-bouncer.ts",
    title: "OrderService p99 climbing; pool stats say everything is fine",
    initialAlert:
      "[P1] OrderService: p99 4-8s, customer success ~50%. pg_stat_activity " +
      "looks fine — active queries ≤ 3 at any moment. Application pool " +
      "stats: totalCount low, idleCount HIGH, waitingCount 0. None of " +
      "the standard pool tuning helps. On-call paged.",
    drill: noKumoChaosDrill(opts),
    groundTruth:
      "Target has an in-process shared semaphore (BOUNCER_MAX=3) in front " +
      "of its pg Pool (max=20). The semaphore models a pgbouncer-style " +
      "multiplexer that's been undersized for the deployed fleet. Customer " +
      "queries serialize on the semaphore long before reaching the pool; " +
      "pool.waitingCount stays at 0 because the semaphore never lets " +
      "enough through to fill the pool. /__bouncer exposes bouncer.active " +
      "/ bouncer.queued / bouncer.peakWait alongside pool stats — the " +
      "smoking-gun comparison. " +
      "Mitigation: raise BOUNCER_MAX (production: pgbouncer " +
      "max_client_conn / default_pool_size), shard per-service, or drop " +
      "the bouncer entirely if the database tolerates direct connections.",
    pages: [
      { atSec: 18, severity: "info", text: "Datadog: pool stats look fine — waitingCount=0, idleCount high. pg_stat_activity shows ≤3 active queries always." },
      { atSec: 55, severity: "warn", text: "Customer support: orders timing out at 5-8s p99. Failed orders are timeouts, not errors." },
      { atSec: 110, severity: "info", text: "Platform colleague: 'If pool.waitingCount=0 and queries are slow, something UPSTREAM of the pool is serializing. Check /__bouncer.'" },
    ],
    redHerrings: [
      { hypothesis: "Bumped pool.max as if pool was the bottleneck", matchKeyword: "(pool\\.max|max:\\s*\\d+).*(raise|increase|bump)" },
      { hypothesis: "Added SDK retries", matchKeyword: "(retry|maxAttempts).*(slow|timeout|bouncer)" },
      { hypothesis: "Looked for kumo chaos", matchKeyword: "(check|inspect).*(kumo|/kumo/chaos)" },
    ],
    idealPath: [
      "Inspect /__bouncer — see bouncer.active=3 / bouncer.queued high; pool.waitingCount=0 / pool.idleCount HIGH",
      "Read target source — find BOUNCER_MAX semaphore in front of pool",
      "Hypothesize: shared multiplexer is the bottleneck, not the local pool",
      "Mitigate: raise BOUNCER_MAX, shard, or drop the bouncer",
      "Verify /orders sustains ≥80%",
    ],
    rubric: [
      investigatedBeforeEditing(3),
      readTargetSource(5),
      statedHypothesis(2),
      didNotAddRetries(3),
      minimalCodeChange(3, 3),
      recoveredSlo(3),
      ...(opts.customerUrl ? [customerImpactRecovered({ customerUrl: opts.customerUrl, weight: 5 })] : []),
      llmJudged({
        id: "raised-bouncer-not-pool",
        weight: 7,
        description: "Identified the shared bouncer / semaphore as the bottleneck and raised it (or removed it); did NOT just tune the local pool",
        question: "Did the agent identify the shared bouncer / semaphore (BOUNCER_MAX) as the bottleneck and raise/remove it? Or did they tune the local pool.max (wrong layer)? Answer YES for bouncer fixes; NO for pool-only tuning, retries, or unrelated changes.",
        regexFallback: (ctx) => /(BOUNCER_MAX\s*=\s*[1-9]\d+|raise.*bouncer|remove.*bouncer|drop.*bouncer|max_client_conn|default_pool_size|semaphore.*cap.*increase)/i.test((ctx.journalContents ?? []).join("\n") + "\n" + (ctx.transcript ?? "")),
      }),
    ],
  };
}
