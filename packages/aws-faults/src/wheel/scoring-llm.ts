/**
 * LLM-judged rubric primitives.
 *
 * Replaces the brittle regex+keyword approach for "did the agent
 * describe X?" criteria. A small LLM call ("answer YES or NO: ...")
 * is much more tolerant of paraphrase, but it's async and incurs API
 * cost.
 *
 * The judge runs in the runner's pre-scoring phase (like __probe
 * callbacks), results are stuffed into ScoringContext.llmVerdicts,
 * and the synchronous `check()` reads from there.
 *
 * Fallback: if no ANTHROPIC_API_KEY is set, judges return undefined
 * (verdict missing); the criterion then falls back to the optional
 * regexFallback. This keeps the harness functional offline.
 */
import type { RubricCriterion, ScoringContext } from "./types.ts";

export interface LLMJudgeConfig {
  /** Anthropic API key. Defaults to process.env.ANTHROPIC_API_KEY. */
  apiKey?: string;
  /** Model id. Defaults to "claude-haiku-4-5-20251001" — small + cheap. */
  model?: string;
  /** Max tokens per judge call. Default 50 (yes/no only). */
  maxTokens?: number;
}

/**
 * Build the prompt context the judge sees. We give it the agent's
 * transcript + journal + a constraint to answer YES or NO.
 */
function buildJudgePrompt(question: string, ctx: ScoringContext): string {
  const parts: string[] = [
    "You are a strict but fair on-call evaluator. Answer the question with exactly one word: YES or NO.",
    "",
    "Question:",
    question,
    "",
    "Evidence — the agent's post-incident summary:",
    ctx.transcript || "(empty)",
  ];
  if (ctx.journalContents && ctx.journalContents.length > 0) {
    parts.push("");
    parts.push("Evidence — the agent's running journal:");
    parts.push(ctx.journalContents.join("\n---\n"));
  }
  parts.push("");
  parts.push("Answer (YES or NO):");
  return parts.join("\n");
}

/**
 * Async judge call. Returns true/false, or undefined if no API key is
 * available (caller falls back to regex).
 */
export async function llmJudge(
  question: string,
  ctx: ScoringContext,
  config: LLMJudgeConfig = {},
): Promise<boolean | undefined> {
  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return undefined;
  const model = config.model ?? "claude-haiku-4-5-20251001";
  const maxTokens = config.maxTokens ?? 50;

  const prompt = buildJudgePrompt(question, ctx);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      process.stderr.write(`[llm-judge] HTTP ${res.status} from Anthropic\n`);
      return undefined;
    }
    const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = body.content?.find((c) => c.type === "text")?.text ?? "";
    if (/\byes\b/i.test(text)) return true;
    if (/\bno\b/i.test(text)) return false;
    process.stderr.write(`[llm-judge] ambiguous response: "${text.slice(0, 100)}"\n`);
    return undefined;
  } catch (err) {
    process.stderr.write(`[llm-judge] error: ${err}\n`);
    return undefined;
  }
}

/**
 * Factory for an LLM-judged rubric primitive. The `question` is a
 * yes/no question phrased so YES means the criterion is satisfied.
 *
 * If the runner has populated `ctx.llmVerdicts[id]`, that wins. If
 * not (no API key / judge failed), the optional `regexFallback` is
 * used. If neither, the criterion FAILs.
 */
export function llmJudged(opts: {
  id: string;
  description: string;
  question: string;
  weight: number;
  regexFallback?: (ctx: ScoringContext) => boolean;
  failHint?: string;
}): RubricCriterion & { __llmJudge: (ctx: ScoringContext) => Promise<boolean | undefined> } {
  return {
    id: opts.id,
    description: opts.description,
    weight: opts.weight,
    failHint: opts.failHint,
    check: (ctx) => {
      const v = ctx.llmVerdicts?.[opts.id];
      if (v !== undefined) return v;
      return opts.regexFallback?.(ctx) ?? false;
    },
    __llmJudge: async (ctx) => llmJudge(opts.question, ctx),
  };
}

/**
 * Drop-in upgrade for the brittle text-evidence criteria. Each takes
 * its weight and an optional regex fallback for offline operation.
 */
export function llmStatedHypothesis(weight = 2, regexFallback?: (ctx: ScoringContext) => boolean) {
  return llmJudged({
    id: "stated-hypothesis",
    description: "Stated an explicit hypothesis before acting (LLM-judged)",
    weight,
    question:
      "Did the agent explicitly state a hypothesis or root cause about what was happening, " +
      "before proposing or making a mitigation? Even if the cause was wrong, count it as YES " +
      "if they articulated a hypothesis. Brief one-line statements like 'the chaos is X' " +
      "count.",
    regexFallback,
    failHint: "Acted without an explicit hypothesis.",
  });
}

export function llmReadTargetSource(weight = 2, regexFallback?: (ctx: ScoringContext) => boolean) {
  return llmJudged({
    id: "read-target-source",
    description: "Read the target app source before changing it (LLM-judged)",
    weight,
    question:
      "Did the agent read the target's source code (target/src/server.ts or similar) " +
      "and reason about specific code-level details — function names, control flow, " +
      "data dependencies — before editing? Reading file contents counts. " +
      "Simply 'edited the file' without describing it doesn't.",
    regexFallback,
    failHint: "Edited target without reading or describing it first.",
  });
}

export function llmCheckedKumoChaosStats(weight = 2, regexFallback?: (ctx: ScoringContext) => boolean) {
  return llmJudged({
    id: "checked-chaos-stats",
    description: "Queried the simulated AWS Health Dashboard (LLM-judged)",
    weight,
    question:
      "Did the agent query the kumo chaos endpoints (e.g. GET /kumo/chaos/rules or stats) " +
      "and reason about what specific rules were firing? References to the rule names, " +
      "match counts, or 'no chaos rule matched this service' all count.",
    regexFallback,
    failHint: "Did not inspect the simulated AWS chaos state.",
  });
}
