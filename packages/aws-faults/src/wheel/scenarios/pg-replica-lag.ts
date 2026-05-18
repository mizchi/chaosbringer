/**
 * Scenario: Postgres replica-lag / read-your-own-write violation
 * (#119 Gap 1 follow-up).
 *
 * Pedagogical novelty: the consistency mental model. Every prior
 * write-then-read scenario assumed the read SEES the write. Here
 * the write succeeds, the row exists in the database, but reads
 * against a lagging replica return 0 rows for ~1.5s.
 *
 * Symptom from the SPA journey: POST /orders → 200 with id. GET
 * /verify/:id within the next 1.5s → 404. Customer-visible:
 * "I placed an order but the page says it's not there."
 *
 * Mitigations (any of):
 *   1. INSERT ... RETURNING — serve the row from the same statement
 *      so a separate SELECT isn't needed.
 *   2. Prefer-primary for reads-after-writes (in real RDS: read
 *      replica routing + a per-session "follow primary" flag).
 *   3. Bounded retry with backoff on the SELECT — poll until the
 *      replica catches up.
 *   4. Issue the verify against the same in-memory state the write
 *      went to, defer eventual SELECT for non-blocking confirmation.
 *
 * Wrong directions:
 *   - Retrying the INSERT (the write already succeeded).
 *   - Removing the verify step (drops invariant coverage — the
 *     journey is supposed to confirm the row exists).
 *   - Bumping pool size or any other pool tuning (irrelevant — this
 *     scenario uses pool max=20; pool is not the bottleneck).
 *   - Looking for kumo chaos rules (none exist for this scenario).
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

export interface PgReplicaLagOptions {
  probeUrl: string;
  customerUrl?: string;
  durationMs?: number;
}

function noKumoChaosDrill(opts: PgReplicaLagOptions): Drill {
  return {
    id: "no-kumo-chaos",
    name: "No kumo chaos — fault is JS-level in target (pg replica-lag)",
    description:
      "pg-chaos replica-lag rule hides recently-INSERTed rows from " +
      "subsequent SELECTs for ~1.5s. kumo is irrelevant.",
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

export function pgReplicaLag(opts: PgReplicaLagOptions): Scenario {
  return {
    id: "pg-replica-lag",
    chaosModelVersion: "fixed-v1",
    baselineFile: "server.pg-replica.ts",
    title: "Customers complain 'I ordered but the page says it's not there'",
    initialAlert:
      "[P1] OrderService: POST /orders is at 99% success. /verify/:id is at 38% " +
      "success — for recently-placed orders, GET /verify/:id returns 404 most of " +
      "the time. Customer support: 14 tickets in 30 min, all 'page says order " +
      "missing right after I placed it.' kumo /kumo/chaos/rules: empty.",
    drill: noKumoChaosDrill(opts),
    groundTruth:
      "The target uses Postgres on localhost:5432. pg-chaos has a replica-lag " +
      "rule (p=0.6, lagMs=1500) wrapped around the Pool — for ~1.5s after an " +
      "INSERT, ~60% of SELECT-by-id queries against that id return 0 rows. The " +
      "row IS persisted (a delayed SELECT or a direct psql query will find it); " +
      "the chaos simulates a read replica that's behind the primary. " +
      "Mitigation must change the read-after-write pattern: use INSERT ... " +
      "RETURNING (no separate read), pin reads-after-write to the primary, or " +
      "poll with bounded backoff. Retrying the INSERT is wrong (the write " +
      "succeeded). Removing the verify step is wrong (drops invariant coverage). " +
      "This is NOT a pool problem; the pool has max=20 and waitingCount=0. " +
      "This is NOT a kumo problem; no kumo chaos is active.",
    pages: [
      {
        atSec: 18,
        severity: "info",
        text:
          "AWS Health: no incidents. kumo chaos stats: empty rules list.",
      },
      {
        atSec: 45,
        severity: "warn",
        text:
          "Datadog: a colleague ran `psql -c 'SELECT count(*) FROM orders'` " +
          "and got the expected row count — the writes ARE landing. Reads from " +
          "the app are the problem.",
      },
      {
        atSec: 95,
        severity: "info",
        text:
          "Platform colleague: 'Read-your-own-write violation? We did add a " +
          "replica recently. Maybe the verify endpoint is hitting the replica " +
          "and seeing stale data?'",
      },
    ],
    redHerrings: [
      {
        hypothesis: "Retried the INSERT as if the write had failed",
        matchKeyword: "(retry|maxAttempts).*INSERT|retry.*write",
      },
      {
        hypothesis: "Tuned pool size as if pool exhaustion was the cause",
        matchKeyword: "(pool\\.max|connectionTimeoutMillis|idleTimeoutMillis).*=",
      },
      {
        hypothesis: "Removed the verify step instead of fixing the consistency model",
        matchKeyword: "(remove|delete|skip).*verify|verify.*\\bnot.*needed",
      },
      {
        hypothesis: "Looked for kumo chaos rules as the cause",
        matchKeyword: "(check|inspect|look).*(kumo|/kumo/chaos)",
      },
    ],
    idealPath: [
      "Confirm via psql / direct SELECT: the writes ARE persisted",
      "Read target/src/server.pg-replica.ts — note INSERT then separate SELECT",
      "Hypothesize: read replica lag is hiding recent writes",
      "Mitigate: INSERT ... RETURNING (or read-after-write retry, or prefer-primary)",
      "Verify /orders -> /verify chain returns status=found sustainably",
    ],
    rubric: [
      investigatedBeforeEditing(3),
      readTargetSource(4),
      statedHypothesis(2),
      didNotAddRetries(2),
      minimalCodeChange(3, 3),
      recoveredSlo(2),
      ...(opts.customerUrl
        ? [customerImpactRecovered({ customerUrl: opts.customerUrl, weight: 5 })]
        : []),
      llmJudged({
        id: "addressed-read-after-write",
        weight: 7,
        description:
          "Addressed the read-after-write consistency violation (e.g. INSERT...RETURNING, prefer-primary, retry-with-backoff on SELECT)",
        question:
          "Given the agent's journal, transcript, and tool uses, did the agent " +
          "correctly identify and mitigate a read-after-write / replica-lag " +
          "consistency violation? A correct mitigation is one of: " +
          "INSERT...RETURNING, pinning the verify-after-write read to the " +
          "primary, bounded retry/polling on the SELECT, or some other " +
          "consistency-aware pattern. Answer NO if the agent retried the " +
          "INSERT (treating the write as failed), removed the verify step, " +
          "or only tuned pool config (which is irrelevant here).",
        regexFallback: (ctx) => {
          const text = (ctx.journalContents ?? []).join("\n") + "\n" + (ctx.transcript ?? "");
          return /(returning|prefer[\s-]*primary|read[\s-]*after[\s-]*write|replica[\s-]*lag|wait.*before.*select|poll.*until|consistent[\s-]*read)/i.test(text);
        },
      }),
    ],
  };
}
