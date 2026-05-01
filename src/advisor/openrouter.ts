/**
 * OpenRouter implementation of `ActionAdvisor`. Default model is
 * `google/gemini-2.5-flash` per the design doc; any
 * vision-capable OpenAI-compatible model OpenRouter exposes will work
 * by overriding `model`.
 *
 * Soft-failure protocol: this provider returns `null` on every recoverable
 * problem (HTTP non-2xx, malformed JSON, missing fields, USD budget
 * exhausted). The crawler treats `null` as "no opinion, fall back to
 * heuristic". The provider does not throw on bad model output —
 * exceptions only escape on programmer errors (e.g. asset missing).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parsePromptFile, renderUserPrompt, type ParsedPrompt } from "./prompts/loader.js";
import type {
  ActionAdvisor,
  AdvisorCandidate,
  AdvisorContext,
  AdvisorSuggestion,
} from "./types.js";

export interface OpenRouterAdvisorOptions {
  apiKey: string;
  /** Default: "google/gemini-2.5-flash". */
  model?: string;
  /** Default: "https://openrouter.ai/api/v1". */
  baseUrl?: string;
  /** Override fetch for tests. Default: globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Cumulative USD ceiling. After this the advisor returns null without hitting the network. */
  budgetUsd?: number;
}

const DEFAULT_MODEL = "google/gemini-2.5-flash";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

const PROMPT_PATH = fileURLToPath(new URL("./prompts/action-selection.md", import.meta.url));

let cachedPrompt: ParsedPrompt | null = null;

function loadPrompt(): ParsedPrompt {
  if (cachedPrompt) return cachedPrompt;
  const raw = readFileSync(PROMPT_PATH, "utf8");
  cachedPrompt = parsePromptFile(raw);
  return cachedPrompt;
}

function formatCandidates(candidates: ReadonlyArray<AdvisorCandidate>): string {
  return candidates.map((c) => `${c.index}. ${c.description}`).join("\n");
}

function stripCodeFence(s: string): string {
  const trimmed = s.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

function validateSuggestion(value: unknown, candidateCount: number): AdvisorSuggestion | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  if (!Number.isInteger(obj.chosenIndex)) return null;
  if (typeof obj.reasoning !== "string") return null;
  const idx = obj.chosenIndex as number;
  if (idx < 0 || idx >= candidateCount) return null;
  const out: AdvisorSuggestion = { chosenIndex: idx, reasoning: obj.reasoning };
  if (typeof obj.confidence === "number") out.confidence = obj.confidence;
  return out;
}

export function openRouterAdvisor(opts: OpenRouterAdvisorOptions): ActionAdvisor {
  const model = opts.model ?? DEFAULT_MODEL;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const httpFetch = opts.fetch ?? globalThis.fetch;
  const budgetUsd = opts.budgetUsd;
  let costSoFarUsd = 0;
  const prompt = loadPrompt();

  return {
    name: `openrouter/${model}`,

    async suggest(ctx: AdvisorContext): Promise<AdvisorSuggestion | null> {
      if (budgetUsd !== undefined && costSoFarUsd >= budgetUsd) return null;

      const userText = renderUserPrompt(prompt.userTemplate, {
        url: ctx.url,
        reason: ctx.reason,
        candidates: formatCandidates(ctx.candidates),
        budgetRemaining: ctx.budgetRemaining,
      });

      const imageDataUrl = `data:image/png;base64,${ctx.screenshot.toString("base64")}`;

      const body = {
        model,
        messages: [
          { role: "system", content: prompt.system },
          {
            role: "user",
            content: [
              { type: "text", text: userText },
              { type: "image_url", image_url: { url: imageDataUrl } },
            ],
          },
        ],
      };

      let response: Response;
      try {
        response = await httpFetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify(body),
        });
      } catch {
        return null;
      }

      if (!response.ok) return null;

      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        return null;
      }

      const usageCost = extractCostUsd(parsed);
      if (usageCost !== null) costSoFarUsd += usageCost;

      const content = extractContent(parsed);
      if (content === null) return null;

      let modelJson: unknown;
      try {
        modelJson = JSON.parse(stripCodeFence(content));
      } catch {
        return null;
      }

      return validateSuggestion(modelJson, ctx.candidates.length);
    },
  };
}

function extractContent(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}

function extractCostUsd(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const usage = (body as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const cost = (usage as { total_cost?: unknown }).total_cost;
  return typeof cost === "number" ? cost : null;
}
