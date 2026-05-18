/**
 * Scenario: Postgres connection-pool exhaustion (#119 Gap 1 — storage diversity).
 *
 * Pedagogical novelty: ALL prior scenarios are AWS-SDK-mediated.
 * This one uses real PostgreSQL via the `pg` Pool client, with
 * fault injection at the JS level (see pg-chaos.ts). The agent
 * sees real pg errors, queries pg server state via /pg-chaos/stats
 * (which surfaces pool.totalCount / idleCount / waitingCount), and
 * must mitigate via pool config — not via SDK retry tuning, not
 * via kumo chaos endpoints (kumo is irrelevant here).
 *
 * Failure mechanics:
 *   - Target wraps its pg Pool with a 15% pool-exhaustion fault: a
 *     fraction of /orders calls hold their borrowed connection for
 *     60 seconds before releasing.
 *   - Pool max=5. After ~5 stuck queries, every other request
 *     queues on pool.connect() and eventually trips the pool's
 *     connectionTimeoutMillis (5s) → 503.
 *
 * Correct path:
 *   1. Read /pg-chaos/stats — see pool.totalCount=5,
 *      waitingCount=N, stuckActive>0
 *   2. Read target/src/server.pg-pool.ts — see pool max=5,
 *      idleTimeoutMillis=30000, no statement_timeout
 *   3. Recognize: pool exhausted by long-held queries
 *   4. Mitigation options (any of):
 *        - Raise pool max + add statement_timeout to kill long queries
 *        - Configure SET statement_timeout on each query
 *        - Run a periodic pg_terminate_backend sweep on
 *          pg_stat_activity entries older than N seconds
 *   5. Verify /orders sustains ≥ 80%
 *
 * Wrong paths:
 *   - Adding application-level retries (each retry queues on the
 *     same exhausted pool)
 *   - Disabling the chaos source by editing pg-chaos config (it's
 *     baked into the variant; agent edits source as last resort
 *     but the lesson is "real production won't let you remove the
 *     bad queries; mitigate around them")
 *   - Looking at kumo chaos endpoints (this is NOT a kumo problem)
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

export interface PgPoolExhaustionOptions {
  probeUrl: string;
  customerUrl?: string;
  durationMs?: number;
}

/**
 * No-kumo-chaos drill. The harness's drill abstraction assumes
 * kumo-side rule installation; for the storage-diversity scenarios
 * we ship an empty rule list so prepare's chaos-installation loop
 * is a no-op. The real chaos lives in the target variant's source.
 */
function noKumoChaosDrill(opts: PgPoolExhaustionOptions): Drill {
  return {
    id: "no-kumo-chaos",
    name: "No kumo chaos — fault is JS-level in target",
    description:
      "Storage-diversity scenarios inject faults in-process (pg/Redis) " +
      "rather than at the AWS API boundary. kumo is irrelevant.",
    peakPhaseIndex: 0,
    phases: [{ label: "in-process-chaos", durationMs: 90_000, rules: [] }],
    healthCheck: async () => {
      try {
        const r = await fetch(opts.probeUrl, { method: "POST", signal: AbortSignal.timeout(10_000) });
        return { ok: r.ok, latencyMs: 0, errorRate: r.ok ? 0 : 1 };
      } catch {
        return { ok: false, latencyMs: 0, errorRate: 1 };
      }
    },
    acceptance: { errorRate: 0.05, consecutiveGreen: 5 },
  };
}

export function pgPoolExhaustion(opts: PgPoolExhaustionOptions): Scenario {
  return {
    id: "pg-pool-exhaustion",
    chaosModelVersion: "fixed-v1",
    baselineFile: "server.pg-pool.ts",
    title: "OrderService /orders timing out; PG queries appear stuck",
    initialAlert:
      "[P1] OrderService: customer success rate at 31%, latency p99 climbing past 5s. " +
      "Application logs show 'timeout exceeded when trying to connect' from pg. " +
      "kumo /kumo/chaos/rules: no rules installed (so this is NOT an AWS issue). " +
      "Recent deploy: 2 hours ago, touched query path. On-call paged.",
    drill: noKumoChaosDrill(opts),
    groundTruth:
      "This is NOT a kumo-mediated AWS scenario. The target uses real PostgreSQL " +
      "(host localhost:5432) via the `pg` npm module. A 15% pool-exhaustion fault " +
      "is wrapped around the Pool — a fraction of /orders queries hold their " +
      "borrowed connection for 60 seconds before completing. With pool max=5, the " +
      "pool exhausts quickly and every subsequent request times out on " +
      "pool.connect() (connectionTimeoutMillis=5s). " +
      "/pg-chaos/stats exposes pool.totalCount / idleCount / waitingCount plus " +
      "the chaos engine's stuckActive count. " +
      "Mitigation must live in the pool config or query path: raise max, set " +
      "statement_timeout, or terminate long-running queries via pg_terminate_backend. " +
      "Adding application-level retries amplifies the queue pressure and does NOT " +
      "help — every retry just queues on the same exhausted pool. ",
    pages: [
      {
        atSec: 18,
        severity: "info",
        text:
          "AWS Health Dashboard: no current AWS incidents. CloudWatch shows kumo at " +
          "normal levels.",
      },
      {
        atSec: 40,
        severity: "warn",
        text:
          "Datadog: PostgreSQL pg_stat_activity shows 5 queries with state='active' " +
          "and query_start older than 30s. waiting=12, totalCount=5.",
      },
      {
        atSec: 95,
        severity: "info",
        text:
          "Platform colleague: 'pg_stat_activity is the giveaway — five queries " +
          "stuck active. Either raise max + statement_timeout, or kill the long " +
          "ones with pg_terminate_backend. Don\\'t add retries — they\\'ll queue " +
          "on the same pool.'",
      },
    ],
    redHerrings: [
      {
        hypothesis: "Looked for kumo chaos rules as the cause",
        matchKeyword: "(check|inspect|look).*(kumo|/kumo/chaos)",
      },
      {
        hypothesis: "Added application-level retries to absorb the timeouts",
        matchKeyword: "(retry|maxAttempts).*(pool|timeout|exhausted)",
      },
      {
        hypothesis: "Deleted or edited the chaos config in pg-pool source",
        matchKeyword: "(remove|delete|comment.*out).*(wrapPool|pgChaosConfig|chaos)",
      },
    ],
    idealPath: [
      "Inspect /pg-chaos/stats — see pool 5/5 active, 12 waiting, stuckActive>0",
      "Read target/src/server.pg-pool.ts — see pool max=5, no statement_timeout",
      "Hypothesize: pool exhausted by long-running queries",
      "Mitigate: raise pool max + set statement_timeout (or pg_terminate_backend)",
      "Verify /orders sustains ≥ 80%",
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
      // Signature criterion: did the agent mitigate at the right layer
      // (pool config / statement_timeout / pg_terminate_backend), NOT
      // at the wrong layer (SDK retries, deleting the chaos config,
      // hitting kumo endpoints)? LLM-judged because the right move is
      // descriptive (a specific class of mitigation) and regex would
      // be brittle.
      llmJudged({
        id: "mitigated-pool-not-retries",
        weight: 6,
        description:
          "Mitigation targets the pool / query layer (raise max, statement_timeout, terminate long queries), NOT application-level retries",
        question:
          "Given the agent's journal, transcript, and tool uses, did " +
          "the agent's mitigation target the POOL or QUERY layer " +
          "(raising pool max, setting statement_timeout, calling " +
          "pg_terminate_backend, or otherwise capping query runtime)? " +
          "Answer YES if so; NO if the mitigation was application-level " +
          "retries on top of the exhausted pool, or removing the chaos " +
          "source from the target's code.",
        regexFallback: (ctx) => {
          const text = (ctx.journalContents ?? []).join("\n") + "\n" + (ctx.transcript ?? "");
          return /(pool\s*max|statement_timeout|pg_terminate_backend|max:\s*\d+|connectionTimeoutMillis|idleTimeoutMillis)/i.test(text);
        },
      }),
    ],
  };
}
