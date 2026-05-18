/**
 * Scenario: Postgres slow writes / vacuum-lock pattern
 * (#119 Gap 1 — third pg-chaos scenario using slow-query inject).
 *
 * Pedagogically positioned between pg-pool-exhaustion (pool blocked)
 * and pg-replica-lag (read-after-write violation): writes succeed
 * eventually but slowly. Reads are fast. Models a table mid-VACUUM,
 * write-lock contention on a hot row, or a missing index on a
 * write path.
 *
 * Symptoms the agent sees:
 *   - Customer p99 explodes; many /orders calls hit the 5s
 *     pool.connectionTimeoutMillis-shaped tail
 *   - Reads (/verify/:id) are instant
 *   - /pg-chaos/stats shows `slowed` count climbing; pool.waitingCount=0
 *     (pool isn't the bottleneck — the queries themselves are slow)
 *
 * Correct mitigations (any of):
 *   - Add SET LOCAL statement_timeout per query/session so long
 *     writes fail fast; surface the failure cleanly
 *   - Wrap the query with an AbortController/Promise.race timeout
 *     so the customer path doesn't wait > Nms
 *   - Move the slow write to an async write-ahead queue (decoupled
 *     from the customer response, durability preserved)
 *
 * Wrong directions:
 *   - Bump pool.max (pool isn't the bottleneck)
 *   - Application-level retries on slow queries (each retry hits
 *     the same slow path; aggregate customer wait gets WORSE)
 *   - Looking for kumo chaos rules (this is JS-level)
 *   - Switching the customer-facing endpoint to skip the write
 *     (drops durability invariant)
 */
import type { Scenario } from "../types.ts";
import {
  customerImpactRecovered,
  didNotAddRetries,
  investigatedBeforeEditing,
  minimalCodeChange,
  readTargetSource,
  recoveredSlo,
  statedHypothesis,
} from "../scoring.ts";
import { llmJudged } from "../scoring-llm.ts";
import type { Drill } from "../../orchestrator.ts";

export interface PgSlowWritesOptions {
  probeUrl: string;
  customerUrl?: string;
  durationMs?: number;
}

function noKumoChaosDrill(opts: PgSlowWritesOptions): Drill {
  return {
    id: "no-kumo-chaos",
    name: "No kumo chaos — fault is JS-level slow-query on pg writes",
    description:
      "pg-chaos slow-query rule adds ~4s latency to 40% of INSERT/UPDATE " +
      "queries. SELECTs are unaffected. Pool max=20 (not the bottleneck). " +
      "kumo is irrelevant.",
    peakPhaseIndex: 0,
    phases: [{ label: "in-process-chaos", durationMs: 90_000, rules: [] }],
    healthCheck: async () => {
      try {
        const r = await fetch(opts.probeUrl, { method: "POST", signal: AbortSignal.timeout(15_000) });
        return { ok: r.ok, latencyMs: 0, errorRate: r.ok ? 0 : 1 };
      } catch {
        return { ok: false, latencyMs: 0, errorRate: 1 };
      }
    },
    acceptance: { errorRate: 0.05, consecutiveGreen: 5 },
  };
}

export function pgSlowWrites(opts: PgSlowWritesOptions): Scenario {
  return {
    id: "pg-slow-writes",
    chaosModelVersion: "fixed-v1",
    baselineFile: "server.pg-slow.ts",
    title: "OrderService writes timing out; reads are fine",
    initialAlert:
      "[P1] OrderService: customer success rate 60%, p99 latency 4.5s. Errors " +
      "are HTTP timeouts on POST /orders. Read paths (/verify) are 99% " +
      "responsive. kumo /kumo/chaos/rules: empty. PostgreSQL host alive " +
      "and responding to direct queries. Recent change: a colleague mentioned " +
      "they ran a manual VACUUM on the orders table this morning to reclaim " +
      "space — could be related. On-call paged.",
    drill: noKumoChaosDrill(opts),
    groundTruth:
      "The target uses real Postgres. pg-chaos has a slow-query rule (p=0.4, " +
      "latencyMs=4000, matchSql='^\\s*(INSERT|UPDATE)') wrapped around the " +
      "Pool — 40% of writes sleep 4 seconds before executing. SELECTs are " +
      "unaffected, which is why the verify path is fast. The pool has " +
      "max=20 and waitingCount stays near 0; the pool ISN'T the bottleneck. " +
      "Pool tuning won't help — the queries themselves are slow. " +
      "Mitigation must cap the per-query latency: SET LOCAL statement_timeout " +
      "(fail fast, surface the error), wrap with AbortController in the app, " +
      "or move the write off the customer path into an async queue. " +
      "Application retries DOUBLE the customer wait (each retry hits another " +
      "slow query). The colleague's VACUUM reference is a thematic clue: " +
      "vacuum-lock contention DOES slow writes while reads stay fast.",
    pages: [
      {
        atSec: 20,
        severity: "warn",
        text:
          "Datadog: pg_stat_activity shows several long-running writes (state=active, " +
          "query_start older than 3s) but pool.waitingCount=0 and idleCount=18.",
      },
      {
        atSec: 60,
        severity: "info",
        text:
          "Platform colleague: 'I ran VACUUM ANALYZE on orders this morning. " +
          "Probably contention with our writes — sorry. Reads are fine because " +
          "they hit the snapshot view.'",
      },
      {
        atSec: 110,
        severity: "info",
        text:
          "Reminder from on-call playbook: 'statement_timeout is your friend " +
          "for unbounded-wait incidents. Capping at, say, 2s gives the customer " +
          "path a fast failure instead of an indefinite hang.'",
      },
    ],
    redHerrings: [
      {
        hypothesis: "Increased pool.max (pool isn't the bottleneck)",
        matchKeyword: "(pool\\.max|max:\\s*\\d+|increase.*pool)",
      },
      {
        hypothesis: "Added application-level retries (compounds the wait)",
        matchKeyword: "(retry|maxAttempts).*(slow|timeout|INSERT|write)",
      },
      {
        hypothesis: "Looked for kumo chaos rules as the cause",
        matchKeyword: "(check|inspect|look).*(kumo|/kumo/chaos)",
      },
      {
        hypothesis: "Dropped the write to make /orders return faster",
        matchKeyword:
          "(remove|skip|drop).*INSERT|skipped.*write|return.*before.*INSERT",
      },
    ],
    idealPath: [
      "Confirm via psql / pg_stat_activity: writes ARE active and slow",
      "Read target/src/server.pg-slow.ts — note no statement_timeout, no per-call cap",
      "Hypothesize: slow writes (vacuum-lock or similar) — cap per-query latency",
      "Mitigate: statement_timeout or AbortController on the write, or async queue",
      "Verify /orders ≥ 80% with bounded p99",
    ],
    rubric: [
      investigatedBeforeEditing(3),
      readTargetSource(4),
      statedHypothesis(2),
      didNotAddRetries(4),
      minimalCodeChange(3, 3),
      recoveredSlo(3),
      ...(opts.customerUrl
        ? [customerImpactRecovered({ customerUrl: opts.customerUrl, weight: 5 })]
        : []),
      llmJudged({
        id: "capped-query-latency",
        weight: 6,
        description:
          "Mitigation caps per-query latency (statement_timeout / AbortController / async queue), NOT pool tuning or retries",
        question:
          "Given the agent's journal, transcript, and tool uses, did the agent " +
          "mitigate the slow-write problem by capping per-query latency or " +
          "decoupling the write from the customer path? Correct mitigations: " +
          "SET statement_timeout (per-session or per-query), AbortController " +
          "/ Promise.race timeout in the app, async write-ahead queue. " +
          "Answer NO if the mitigation was bumping pool.max (pool isn't the " +
          "bottleneck), adding retries (compounds wait), removing the write " +
          "entirely (drops durability), or looking for kumo chaos rules.",
        regexFallback: (ctx) => {
          const text = (ctx.journalContents ?? []).join("\n") + "\n" + (ctx.transcript ?? "");
          return /(statement_timeout|AbortController|Promise\.race|write.*queue|async.*write|cap.*latency|cap.*timeout)/i.test(text);
        },
      }),
    ],
  };
}
