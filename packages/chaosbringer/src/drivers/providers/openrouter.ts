/**
 * OpenRouter implementation of `DriverProvider`. Default model is the
 * cheap vision-capable `google/gemini-2.5-flash`. Any OpenAI-compatible
 * vision model OpenRouter exposes will work by overriding `model`.
 *
 * Soft-failure: every recoverable error (non-2xx, malformed JSON,
 * missing fields, out-of-range index, USD budget exhausted) collapses
 * to `null`. The caller (`aiDriver`) treats `null` as "no opinion".
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parsePromptFile,
  parseSuggestion,
  renderUserPrompt,
  type ParsedPrompt,
} from "../prompts/loader.js";
import type { DriverProvider, DriverProviderInput, DriverProviderResult } from "../types.js";

export interface OpenRouterDriverProviderOptions {
  apiKey: string;
  /** Default: "google/gemini-2.5-flash". */
  model?: string;
  /** Default: "https://openrouter.ai/api/v1". */
  baseUrl?: string;
  /** Override fetch for tests. */
  fetch?: typeof globalThis.fetch;
  /** Stop calling once cumulative reported cost reaches this USD. */
  maxUsd?: number;
  /** Override prompt path (advanced). */
  promptPath?: string;
}

const DEFAULT_MODEL = "google/gemini-2.5-flash";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_PROMPT_PATH = fileURLToPath(new URL("../prompts/driver-step.md", import.meta.url));

const promptCache = new Map<string, ParsedPrompt>();
function loadPrompt(path: string): ParsedPrompt {
  const hit = promptCache.get(path);
  if (hit) return hit;
  const parsed = parsePromptFile(readFileSync(path, "utf8"));
  promptCache.set(path, parsed);
  return parsed;
}

export function openRouterDriverProvider(opts: OpenRouterDriverProviderOptions): DriverProvider {
  const model = opts.model ?? DEFAULT_MODEL;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const httpFetch = opts.fetch ?? globalThis.fetch;
  const maxUsd = opts.maxUsd;
  const promptPath = opts.promptPath ?? DEFAULT_PROMPT_PATH;
  let costSoFarUsd = 0;

  return {
    name: `openrouter/${model}`,

    async selectAction(input: DriverProviderInput): Promise<DriverProviderResult | null> {
      if (maxUsd !== undefined && costSoFarUsd >= maxUsd) return null;

      const prompt = loadPrompt(promptPath);
      const userText = renderUserPrompt(prompt.userTemplate, input);
      const imageDataUrl = `data:image/png;base64,${input.screenshot.toString("base64")}`;

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

      const cost = extractCostUsd(parsed);
      if (cost !== null) costSoFarUsd += cost;

      const content = extractContent(parsed);
      if (content === null) return null;

      const suggestion = parseSuggestion(content, input.candidates.length);
      if (suggestion === null) return null;
      return {
        index: suggestion.index,
        reasoning: suggestion.reasoning,
        confidence: suggestion.confidence,
      };
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
