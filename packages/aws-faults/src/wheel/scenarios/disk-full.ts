/**
 * Scenario: disk-full / log-volume overflow.
 *
 * The target writes verbose JSON logs to a file on the customer
 * path. There's a hardcoded volume cap simulating an OS-level
 * ENOSPC. After ~170 requests the log file exceeds the cap and
 * every subsequent /orders fails with the simulated ENOSPC.
 *
 * Pedagogical axis: operations-style failure with no external
 * chaos. The mitigation vocabulary is log rotation / dropping
 * verbose logging / moving logs off the customer path — concepts
 * that no other scenario in the catalog exercises.
 *
 * Correct mitigations:
 *   - Rotate / truncate the log when it nears the cap.
 *   - Drop the per-request logging from the customer path
 *     (move to async or remove if unused).
 *   - Stream logs to a remote sink instead of local disk.
 *
 * Wrong directions:
 *   - Raise the cap (delays the problem).
 *   - Retry on 503 (writes still fail; same cap).
 *   - Look at kumo / DDB / pool (irrelevant).
 */
import type { Scenario } from "../types.ts";
import { customerImpactRecovered, didNotAddRetries, investigatedBeforeEditing, minimalCodeChange, readTargetSource, recoveredSlo, statedHypothesis } from "../scoring.ts";
import { llmJudged } from "../scoring-llm.ts";
import type { Drill } from "../../orchestrator.ts";

export interface DiskFullOptions { probeUrl: string; customerUrl?: string; durationMs?: number; }

function noKumoChaosDrill(opts: DiskFullOptions): Drill {
  return {
    id: "no-kumo-chaos-disk-full", name: "No kumo chaos — log-volume cap in target", description: "Target's per-request log fills a hardcoded volume cap (simulated ENOSPC). kumo is irrelevant.",
    peakPhaseIndex: 0, phases: [{ label: "in-process-disk-full", durationMs: 90_000, rules: [] }],
    healthCheck: async () => { try { const r = await fetch(opts.probeUrl, { method: "POST", signal: AbortSignal.timeout(15_000) }); return { ok: r.ok, latencyMs: 0, errorRate: r.ok ? 0 : 1 }; } catch { return { ok: false, latencyMs: 0, errorRate: 1 }; } },
    acceptance: { errorRate: 0.05, consecutiveGreen: 5 },
  };
}

export function diskFull(opts: DiskFullOptions): Scenario {
  return {
    id: "disk-full",
    chaosModelVersion: "fixed-v1",
    baselineFile: "server.disk-full.ts",
    title: "OrderService 5xx growing; errors say 'ENOSPC' from the application",
    initialAlert:
      "[P1] OrderService: success rate at 0% in the last 5 minutes. Errors " +
      "all say 'ENOSPC: log volume cap exceeded'. kumo healthy. DDB healthy. " +
      "Recent change: a colleague added per-request structured logging to a " +
      "local file last week 'for debugging' and shipped without rotation. " +
      "On-call paged.",
    drill: noKumoChaosDrill(opts),
    groundTruth:
      "Target writes a ~3KB JSON log line per request to /tmp/wom-orders-log.jsonl " +
      "via fs.appendFileSync on the customer path. There's no rotation. Once the " +
      "file exceeds the hardcoded cap (512KB ≈ ~170 requests) every subsequent " +
      "/orders throws an ENOSPC simulation and returns 503. /__disk exposes the " +
      "current size / cap / fullness ratio. " +
      "Mitigations: rotate or truncate the log when it approaches the cap; drop " +
      "the per-request logging from the customer path entirely; stream logs to " +
      "a remote sink. Raising the cap just delays the same problem.",
    pages: [
      { atSec: 18, severity: "info", text: "Datadog: disk usage on /tmp climbing fast; correlates with request rate." },
      { atSec: 60, severity: "warn", text: "Customer support: orders fail immediately with 'ENOSPC' error — not a timeout." },
      { atSec: 110, severity: "info", text: "Platform colleague: 'curl localhost:3000/__disk shows fullness=0.97. Find what\\'s writing.'" },
    ],
    redHerrings: [
      { hypothesis: "Raised the cap as the fix", matchKeyword: "LOG_CAP_BYTES\\s*=\\s*[1-9]\\d{6,}|capBytes.*(raise|increase|bigger)" },
      { hypothesis: "Added SDK retries on the ENOSPC", matchKeyword: "(retry|maxAttempts).*ENOSPC" },
      { hypothesis: "Blamed kumo / DDB / pool", matchKeyword: "(kumo|ddb|pool).*(cause|root|the bug)" },
    ],
    idealPath: [
      "Check /__disk — see fullness near 1.0",
      "Read target/src/server.disk-full.ts — find logRequest with appendFileSync, no rotation",
      "Hypothesize: log volume cap exceeded",
      "Mitigate: rotate / drop logs / move off customer path",
      "Verify /orders ≥ 80% sustained",
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
        id: "log-volume-mitigated",
        weight: 6,
        description: "Mitigation reduces log volume on customer path (rotate, drop, remote sink) — NOT raise-the-cap",
        question: "Did the agent address the disk-full / log-volume issue by reducing what's written to local disk (rotation, truncate, removing the per-request log, moving to remote sink)? Answer NO if the agent just bumped the cap, added retries, or blamed an unrelated component.",
        regexFallback: (ctx) => /(rotate|truncate|unlink|drop.*log|remove.*logRequest|appendFile.*remove|stream.*sink|async.*log)/i.test((ctx.journalContents ?? []).join("\n") + "\n" + (ctx.transcript ?? "")),
      }),
    ],
  };
}
