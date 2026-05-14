/**
 * Anthropic Messages API implementation of `DriverProvider`. Default
 * model is Haiku 4.5 — the cheap vision-capable tier suitable for the
 * per-step exploration use case.
 *
 * Uses the raw HTTPS endpoint rather than `@anthropic-ai/sdk` to avoid
 * pulling a heavy peer dependency for a thin call. Soft-failure rules
 * mirror the OpenRouter provider: every recoverable error collapses to
 * `null`.
 */
import { parsePromptFile, parseSuggestion, renderUserPrompt, type ParsedPrompt } from "../prompts/loader.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DriverProvider, DriverProviderInput, DriverProviderResult } from "../types.js";

export interface AnthropicDriverProviderOptions {
  apiKey: string;
  /** Default: "claude-haiku-4-5-20251001". */
  model?: string;
  /** Default: "https://api.anthropic.com/v1". */
  baseUrl?: string;
  /** Override fetch for tests. */
  fetch?: typeof globalThis.fetch;
  /** Max tokens for the response. Default: 256. */
  maxTokens?: number;
  /** API version header. Default: "2023-06-01". */
  anthropicVersion?: string;
  promptPath?: string;
}

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_VERSION = "2023-06-01";
const DEFAULT_PROMPT_PATH = fileURLToPath(new URL("../prompts/driver-step.md", import.meta.url));

const promptCache = new Map<string, ParsedPrompt>();
function loadPrompt(path: string): ParsedPrompt {
  const hit = promptCache.get(path);
  if (hit) return hit;
  const parsed = parsePromptFile(readFileSync(path, "utf8"));
  promptCache.set(path, parsed);
  return parsed;
}

export function anthropicDriverProvider(opts: AnthropicDriverProviderOptions): DriverProvider {
  const model = opts.model ?? DEFAULT_MODEL;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const httpFetch = opts.fetch ?? globalThis.fetch;
  const maxTokens = opts.maxTokens ?? 256;
  const version = opts.anthropicVersion ?? DEFAULT_VERSION;
  const promptPath = opts.promptPath ?? DEFAULT_PROMPT_PATH;

  return {
    name: `anthropic/${model}`,

    async selectAction(input: DriverProviderInput): Promise<DriverProviderResult | null> {
      const prompt = loadPrompt(promptPath);
      const userText = renderUserPrompt(prompt.userTemplate, input);

      const body = {
        model,
        max_tokens: maxTokens,
        system: prompt.system,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: input.screenshot.toString("base64"),
                },
              },
              { type: "text", text: userText },
            ],
          },
        ],
      };

      let response: Response;
      try {
        response = await httpFetch(`${baseUrl}/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": opts.apiKey,
            "anthropic-version": version,
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
  const blocks = (body as { content?: unknown }).content;
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") return b.text;
  }
  return null;
}
