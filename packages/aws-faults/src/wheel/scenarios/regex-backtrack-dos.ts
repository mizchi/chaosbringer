/**
 * Scenario: regex backtrack DoS (ReDoS).
 *
 * The bug is ONE LINE: a catastrophic-backtracking regex in the
 * customer path. Adversarial (or accidental) input causes V8's
 * regex engine to consume seconds of CPU per call, pinning the
 * event loop and timing out every concurrent request.
 *
 * Real incidents this models:
 *   - Cloudflare 2019 (global edge outage from one regex).
 *   - StackExchange 2016 (34-minute outage).
 *
 * Pedagogical novelty:
 *   - No external chaos. No kumo / pg rules. The bug is one line
 *     of code in the target.
 *   - The diagnostic skill is event-loop awareness: when DDB
 *     latency is fine, kumo chaos is empty, the pool isn't
 *     exhausted, but EVERY request is slow — the time is being
 *     spent INSIDE the Node process, not waiting for upstream.
 *   - Mitigation is small: rewrite the regex / cap input length /
 *     drop the validation. Restart doesn't help — the pathological
 *     input recurs.
 *
 * Correct mitigations:
 *   1. Rewrite the regex to remove the (a+)+ nested quantifier.
 *   2. Cap input length before running the regex.
 *   3. Drop the validation entirely (it isn't required by the
 *      business logic).
 *
 * Wrong directions:
 *   - SDK retries (the time is spent in the regex, not awaiting AWS).
 *   - Pool tuning (event loop is the bottleneck).
 *   - Restart only (the next bad input re-triggers).
 *   - Looking at kumo / DDB / pg chaos rules.
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

export interface RegexBacktrackDosOptions {
  probeUrl: string;
  customerUrl?: string;
  durationMs?: number;
}

function noKumoChaosDrill(opts: RegexBacktrackDosOptions): Drill {
  return {
    id: "no-kumo-chaos-regex-dos",
    name: "No kumo chaos — catastrophic regex in target",
    description:
      "Customer path runs a catastrophic-backtracking regex on the body's " +
      "`note` field. Adversarial input pins the event loop. kumo is irrelevant.",
    peakPhaseIndex: 0,
    phases: [{ label: "in-process-cpu-burn", durationMs: 90_000, rules: [] }],
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

export function regexBacktrackDos(opts: RegexBacktrackDosOptions): Scenario {
  return {
    id: "regex-backtrack-dos",
    chaosModelVersion: "fixed-v1",
    baselineFile: "server.regex-dos.ts",
    title: "OrderService 100% timeouts; one specific customer keeps retrying",
    initialAlert:
      "[P1] OrderService: success rate dropped from 99% to 8% over the last " +
      "two minutes. p99 latency >30s. CloudWatch shows EC2 CPU at 100%; " +
      "DDB metrics normal. kumo /kumo/chaos/rules: empty. Traffic volume " +
      "is normal but one client is retrying aggressively. On-call paged.",
    drill: noKumoChaosDrill(opts),
    groundTruth:
      "The target's POST /orders runs a catastrophic-backtracking regex " +
      "(`/^(a+)+!$/`) against the body's `note` field on every request. " +
      "A client sending notes of length 28+ consisting of all 'a' chars " +
      "without the required trailing '!' triggers exponential backtracking " +
      "in V8's regex engine — seconds of CPU per call, blocking the event " +
      "loop. Every concurrent request times out client-side. " +
      "Diagnostic giveaway: /__cpu shows event-loop p99 delay >100ms; " +
      "kumo / DDB look healthy; CPU is pinned at 100% on the Node " +
      "process. " +
      "Mitigation must rewrite the regex (remove the (a+)+ nested " +
      "quantifier), cap input length before validation, or drop the " +
      "validation entirely. Restart alone does not help — the next bad " +
      "input re-triggers the lockup.",
    pages: [
      {
        atSec: 18,
        severity: "info",
        text:
          "Datadog: Node process CPU at 100%. DDB latency p99 normal " +
          "(<50ms). kumo /kumo/chaos/stats: no rules installed.",
      },
      {
        atSec: 50,
        severity: "warn",
        text:
          "Network logs: one IP is sending 4 POSTs/sec to /orders with " +
          "a 30-character body. Each call appears to take ~6 seconds " +
          "server-side before timing out client-side.",
      },
      {
        atSec: 95,
        severity: "info",
        text:
          "Platform colleague: 'curl localhost:3000/__cpu and watch the " +
          "eventLoopDelayMs. If it\\'s >100ms while DDB is healthy, you " +
          "have something CPU-bound. Likely a regex or a JSON-bomb.'",
      },
    ],
    redHerrings: [
      {
        hypothesis: "Added SDK retries",
        matchKeyword: "(retry|maxAttempts).*(timeout|slow|cpu)",
      },
      {
        hypothesis: "Restarted target without fixing the regex",
        matchKeyword: "(restart|kill).*target(?!.*regex|.*validation|.*note)",
      },
      {
        hypothesis: "Blamed kumo / DDB / network as the cause",
        matchKeyword: "(kumo|ddb|network|connection).*(cause|root|the bug|slow)",
      },
      {
        hypothesis: "Tuned pool size as if pool was the bottleneck",
        matchKeyword: "(pool\\.max|increase.*pool|raise.*pool)",
      },
    ],
    idealPath: [
      "Inspect /__cpu — see event loop p99 delay >>100ms",
      "Check kumo / DDB — both healthy. Conclusion: CPU-bound in target.",
      "Read target/src/server.regex-dos.ts — find NOTE_VALIDATION_REGEX",
      "Hypothesize: catastrophic backtracking on (a+)+",
      "Mitigate: rewrite regex / cap input length / drop validation",
      "Verify /orders returns to <500ms p99",
    ],
    rubric: [
      investigatedBeforeEditing(3),
      readTargetSource(5),
      statedHypothesis(3),
      didNotAddRetries(3),
      minimalCodeChange(3, 3),
      recoveredSlo(3),
      ...(opts.customerUrl
        ? [customerImpactRecovered({ customerUrl: opts.customerUrl, weight: 5 })]
        : []),
      llmJudged({
        id: "fixed-the-regex",
        weight: 7,
        description:
          "Mitigation targets the catastrophic regex (rewrite / input-length cap / drop validation), NOT SDK retries / pool / restart-only",
        question:
          "Given the agent's journal, transcript, and tool uses, did " +
          "the agent identify the NOTE_VALIDATION_REGEX as the cause " +
          "AND mitigate at the regex / input-validation layer? Valid " +
          "mitigations: rewriting the regex to remove the (a+)+ " +
          "structure, capping input length before validation, or " +
          "dropping the validation. Answer NO if the agent restarted " +
          "without fixing the regex, added retries, tuned the pool, " +
          "or blamed upstream services.",
        regexFallback: (ctx) => {
          const text = (ctx.journalContents ?? []).join("\n") + "\n" + (ctx.transcript ?? "");
          return /(NOTE_VALIDATION_REGEX|regex.*backtrack|catastrophic.*backtrack|RE2|input.*length.*cap|note\.length\s*>|drop.*validation|remove.*validation|rewrite.*regex)/i.test(text);
        },
      }),
    ],
  };
}
