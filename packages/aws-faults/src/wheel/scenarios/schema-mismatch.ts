/**
 * Scenario: schema-mismatch during rolling deploy.
 *
 * Two write paths (v1 and v2) are concurrently active in the target.
 * /verify expects v2; v1 rows look "missing" from the customer-visible
 * verify path even though they ARE in DDB. Models the canonical
 * partial-deploy / backward-compat-broken pattern.
 *
 * Correct mitigations:
 *   - Read-path shim accepting v1 OR v2 (cleanest in real deploys).
 *   - Force uniform v2 writes; backfill old v1 rows.
 *   - Roll back to v1 (lose new fields but uniform schema).
 *
 * Wrong directions:
 *   - Retry POST (different schema each time, won't converge).
 *   - Pool / network tuning (irrelevant).
 *   - Looking at kumo chaos rules (none active).
 */
import type { Scenario } from "../types.ts";
import { customerImpactRecovered, didNotAddRetries, investigatedBeforeEditing, minimalCodeChange, readTargetSource, recoveredSlo, statedHypothesis } from "../scoring.ts";
import { llmJudged } from "../scoring-llm.ts";
import type { Drill } from "../../orchestrator.ts";

export interface SchemaMismatchOptions { probeUrl: string; customerUrl?: string; durationMs?: number; }

function noKumoChaosDrill(opts: SchemaMismatchOptions): Drill {
  return {
    id: "no-kumo-chaos-schema-mismatch", name: "No kumo chaos — partial-deploy schema mismatch in target",
    description: "Target writes v1 OR v2 schemas at random; /verify expects v2 only. kumo is irrelevant.",
    peakPhaseIndex: 0, phases: [{ label: "in-process-schema-skew", durationMs: 90_000, rules: [] }],
    healthCheck: async () => { try { const r = await fetch(opts.probeUrl, { method: "POST", signal: AbortSignal.timeout(15_000) }); return { ok: r.ok, latencyMs: 0, errorRate: r.ok ? 0 : 1 }; } catch { return { ok: false, latencyMs: 0, errorRate: 1 }; } },
    acceptance: { errorRate: 0.05, consecutiveGreen: 5 },
  };
}

export function schemaMismatch(opts: SchemaMismatchOptions): Scenario {
  return {
    id: "schema-mismatch",
    chaosModelVersion: "fixed-v1",
    baselineFile: "server.schema-mismatch.ts",
    title: "Half of POST /orders look successful but verify returns 404",
    initialAlert:
      "[P1] OrderService: POST /orders returns 200 for every customer, but " +
      "the SPA's verify-after-place fetch returns 404 about half the time. " +
      "Customer support: 'I clicked place order, got an id, but the page " +
      "says my order is missing.' Rolling deploy completed 1 hour ago — " +
      "half the fleet is on v2 schema, half still on v1. /verify checks " +
      "version=2 strictly. On-call paged.",
    drill: noKumoChaosDrill(opts),
    groundTruth:
      "Target writes v1 OR v2 schemas at 50/50 (simulating half-deployed " +
      "fleet). v1: {id, ts, amount}. v2: {id, ts, amount, version: 2, " +
      "checksum: ...}. /verify rejects v1 with 404. Rows ARE in DDB; the " +
      "read path is the bug. /__schema-stats exposes the v1/v2 counters " +
      "so the agent can confirm the split. " +
      "Correct mitigations: read-path shim accepting either schema, " +
      "uniform v2 writes (+ backfill v1), or rollback to uniform v1. " +
      "Wrong: retry (won't converge — different schema each call), " +
      "pool tuning, kumo inspection.",
    pages: [
      { atSec: 20, severity: "info", text: "Deploy bot: rolling deploy of v2 schema completed at 12:00; bake-time 1h." },
      { atSec: 50, severity: "warn", text: "Datadog: /verify endpoint returns 404 at ~50% rate; DDB Scan shows rows ARE there but with mixed schemas." },
      { atSec: 110, severity: "info", text: "Platform colleague: 'curl /__schema-stats — if v1Reads404 is climbing while v2Reads200 is too, you have a partial-deploy shape.'" },
    ],
    redHerrings: [
      { hypothesis: "Retried POST until v2 happens to win", matchKeyword: "retry.*POST.*orders|retry.*until.*version" },
      { hypothesis: "Bumped pool / SDK config", matchKeyword: "(pool\\.max|maxAttempts).*=" },
      { hypothesis: "Blamed kumo as the cause", matchKeyword: "(kumo|chaos rule).*(cause|root|the bug)" },
    ],
    idealPath: [
      "Check /__schema-stats — see v1 and v2 writes both growing, only v1 reads 404",
      "Read target source — find writeOrder branching v1 vs v2 at random",
      "Hypothesize: partial deploy / read path doesn't accept v1",
      "Mitigate: read-path shim, OR force uniform v2 + backfill, OR rollback to v1",
      "Verify /orders + /verify pair sustained at ≥80%",
    ],
    rubric: [
      investigatedBeforeEditing(3),
      readTargetSource(5),
      statedHypothesis(2),
      didNotAddRetries(3),
      minimalCodeChange(3, 3),
      recoveredSlo(2),
      ...(opts.customerUrl ? [customerImpactRecovered({ customerUrl: opts.customerUrl, weight: 5 })] : []),
      llmJudged({
        id: "addressed-schema-skew",
        weight: 7,
        description: "Mitigation accepts both schemas in /verify, forces uniform writes, or rolls back to a uniform schema",
        question: "Did the agent address the schema mismatch by accepting both v1 and v2 rows in /verify, forcing uniform writes (one schema or the other), or rolling back? Answer NO if the agent retried POSTs, tuned pool/SDK, or blamed an unrelated component.",
        regexFallback: (ctx) => /(accept.*v1|accept.*both.*schema|version.*===.*[12]|version\s*\|\|\s*2|uniform.*v[12]|backfill|migrate.*v1|rollback.*v[12]|shim)/i.test((ctx.journalContents ?? []).join("\n") + "\n" + (ctx.transcript ?? "")),
      }),
    ],
  };
}
