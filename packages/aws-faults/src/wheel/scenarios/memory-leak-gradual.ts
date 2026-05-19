/**
 * Scenario: gradual memory leak (#119 follow-up).
 *
 * Adds a new pedagogical axis to the catalog: TIME-PROGRESSION
 * awareness. Every prior scenario presents a constant chaos signal
 * during the recovery window; restart-trap even rewards "do
 * nothing" because the chaos eventually self-resolves. Here the
 * problem is in the OPPOSITE direction — chaos GETS WORSE over
 * time as state accumulates. Restarting buys time but is not the
 * fix; the agent must read source, find the unbounded retention,
 * and bound it.
 *
 * Symptom progression:
 *   - First ~50 requests: p99 latency normal.
 *   - Next 100-200 requests: heap grows past 100MB; GC pauses
 *     become noticeable on the customer path.
 *   - Past ~500-700 requests: p99 latency degrades sharply; some
 *     requests time out client-side. Eventually OOM.
 *
 * Observability:
 *   - /__mem returns retainedRequests + heap stats. The agent
 *     should see retainedRequests climbing and recognize the
 *     unbounded growth.
 *   - kumo /kumo/chaos/rules is empty (no external chaos).
 *
 * Correct mitigations:
 *   1. Read target/src/server.mem-leak.ts, find the
 *      `recentRequests.set(...)` line, add eviction (LRU /
 *      max-size / TTL), restart.
 *   2. Eliminate the retention entirely if it isn't needed.
 *
 * Wrong directions:
 *   - Restart only (the leak returns within minutes).
 *   - Pool / SDK retry tuning (irrelevant).
 *   - Looking for kumo chaos rules (none active).
 *   - Blaming GC tuning without fixing the underlying retention.
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

export interface MemoryLeakGradualOptions {
  probeUrl: string;
  customerUrl?: string;
  durationMs?: number;
}

function noKumoChaosDrill(opts: MemoryLeakGradualOptions): Drill {
  return {
    id: "no-kumo-chaos-memory-leak",
    name: "No kumo chaos — gradual memory leak in target source",
    description:
      "Target retains a 256KB buffer per request indefinitely. Symptom " +
      "manifests gradually as state accumulates. kumo is irrelevant.",
    peakPhaseIndex: 0,
    phases: [{ label: "in-process-leak", durationMs: 90_000, rules: [] }],
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

export function memoryLeakGradual(opts: MemoryLeakGradualOptions): Scenario {
  return {
    id: "memory-leak-gradual",
    chaosModelVersion: "fixed-v1",
    baselineFile: "server.mem-leak.ts",
    title: "OrderService p99 climbing over the last hour; no obvious cause",
    initialAlert:
      "[P1] OrderService: p99 latency was 50ms an hour ago, now 1.8s and " +
      "climbing. Error rate at 12% and growing. No deploys in the last 4 " +
      "hours. kumo /kumo/chaos/rules: empty. CloudWatch shows host memory " +
      "and process RSS both trending UP. On-call paged.",
    drill: noKumoChaosDrill(opts),
    groundTruth:
      "The target's source has a memory leak: every request appends a " +
      "256KB buffer to an in-process Map (`recentRequests`) and never " +
      "evicts. After ~500 requests the heap is hundreds of MB; GC pauses " +
      "lengthen; p99 latency climbs. /__mem exposes the retainedRequests " +
      "counter so the agent can confirm the leak exists and watch it " +
      "grow. There is no external chaos — kumo and DDB are healthy. " +
      "Correct mitigation: add an eviction policy to recentRequests " +
      "(LRU / max-size / TTL), or eliminate the retention. Restart " +
      "buys time but is not the fix; the leak returns. " +
      "This scenario is the OPPOSITE pole of restart-trap: there the " +
      "right move is 'do nothing'; here the right move is 'find and " +
      "fix the leak.' The diagnostic skill is recognizing the time " +
      "progression — chaos getting worse, not staying constant.",
    pages: [
      {
        atSec: 15,
        severity: "info",
        text:
          "Datadog: process RSS up 800MB in the last hour. heapUsed up " +
          "proportionally. GC pause p99 was 5ms, now 220ms.",
      },
      {
        atSec: 45,
        severity: "warn",
        text:
          "Customer support: orders are slow but completing. Several " +
          "customers report 'I clicked place order and waited 4 seconds " +
          "for the page to update.'",
      },
      {
        atSec: 100,
        severity: "info",
        text:
          "Platform colleague: 'Try curl localhost:3000/__mem — if " +
          "retainedRequests is climbing, something is holding state. " +
          "That\\'s usually a debug log or telemetry buffer someone " +
          "forgot to bound.'",
      },
    ],
    redHerrings: [
      {
        hypothesis: "Restarted target without finding the leak (returns)",
        matchKeyword: "(restart|kill|nohup).*target(?!.*evict|.*bound|.*size|.*ttl|.*lru)",
      },
      {
        hypothesis: "Bumped Node heap size as a fix",
        matchKeyword: "(max-old-space-size|--heap)",
      },
      {
        hypothesis: "Blamed kumo / DDB / pool as the cause",
        matchKeyword: "(kumo|ddb|pool).*(cause|root|the bug|culprit)",
      },
    ],
    idealPath: [
      "Inspect /__mem — see retainedRequests climbing and heap RSS growing",
      "Read target/src/server.mem-leak.ts — find recentRequests.set without delete",
      "Hypothesize: unbounded retention is the leak",
      "Mitigate: add eviction (LRU / max-size / TTL) OR remove the retention",
      "Restart target so memory drops; verify retainedRequests stays bounded after fix",
    ],
    rubric: [
      investigatedBeforeEditing(3),
      readTargetSource(5),
      statedHypothesis(3),
      didNotAddRetries(2),
      minimalCodeChange(3, 3),
      recoveredSlo(3),
      ...(opts.customerUrl
        ? [customerImpactRecovered({ customerUrl: opts.customerUrl, weight: 4 })]
        : []),
      llmJudged({
        id: "bounded-retention",
        weight: 7,
        description:
          "Mitigation bounds the leaking retention (eviction / max-size / TTL / removed entirely), NOT 'restart and hope' or heap tuning",
        question:
          "Given the agent's journal, transcript, and tool uses, did " +
          "the agent identify the unbounded `recentRequests` Map as the " +
          "leak source AND apply a bounded-retention mitigation? Valid " +
          "mitigations: adding an LRU/max-size/TTL eviction, removing " +
          "the retention entirely, or moving it to a bounded external " +
          "store. Answer NO if the mitigation was restart-only, " +
          "bumping the Node heap size, or blaming an external system.",
        regexFallback: (ctx) => {
          const text = (ctx.journalContents ?? []).join("\n") + "\n" + (ctx.transcript ?? "");
          return /(LRU|max[\s-]*size|TTL|evict|delete.*recentRequests|recentRequests.*delete|bound.*retention|recentRequests.*size\s*>|.shift\(\)|recentRequests\s*=\s*new\s+Map)/i.test(text);
        },
      }),
    ],
  };
}
