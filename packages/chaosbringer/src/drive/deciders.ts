/**
 * Deciders for `drive()`.
 *
 * - `anthropicDecider` / `openRouterDecider`: a model reads the accessibility
 *   outline (`drive-step.md`) and answers with one JSON action. Text only by
 *   default, since the outline already says what is on the page and where;
 *   `vision: true` adds a screenshot for pages whose meaning is in pixels.
 * - `planDecider`: no model. A list of steps, each naming its control by a
 *   pattern on the candidate descriptions (`/Sign in/`, `"Email"`). The
 *   cheap way to script a known flow against the same outline, with the
 *   same checks running.
 *
 * Both model deciders use the raw HTTPS APIs, as the driver providers do,
 * and fail soft: a refused request, an unparsable answer or a timeout is a
 * `null` decision, which `drive` counts and retries.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parsePromptFile, stripCodeFence, type ParsedPrompt } from "../drivers/prompts/loader.js";
import type { DriveDecider, DriveDecision, DriveInput } from "./drive.js";

const PROMPT_PATH = fileURLToPath(new URL("./prompts/drive-step.md", import.meta.url));
let prompt: ParsedPrompt | null = null;
function loadPrompt(path: string): ParsedPrompt {
  if (path !== PROMPT_PATH) return parsePromptFile(readFileSync(path, "utf8"));
  prompt ??= parsePromptFile(readFileSync(path, "utf8"));
  return prompt;
}

/** The user message for `input`, from the prompt template. */
export function renderDrivePrompt(template: string, input: DriveInput): string {
  const history =
    input.history.length === 0
      ? "(nothing yet)"
      : input.history
          .map((h) => {
            const what = [h.action, h.target, h.value !== undefined ? JSON.stringify(h.value) : undefined].filter(Boolean).join(" ");
            const outcome = h.ok ? "ok" : `failed: ${h.error ?? "?"}`;
            const extra = h.problems.length > 0 ? `; problems: ${h.problems.slice(0, 3).join(" | ")}` : "";
            return `${h.step}. ${what} — ${outcome}; now at ${h.url}${extra}`;
          })
          .join("\n");
  const problems =
    input.problems.length === 0 ? "(none)" : input.problems.slice(0, 10).map((p) => `- ${p.kind}: ${p.message.slice(0, 200)}`).join("\n");
  const candidates = input.candidates.length === 0 ? "(none)" : input.candidates.map((c) => `#${c.index} ${c.description}`).join("\n");
  const values: Record<string, string> = {
    goal: input.goal,
    url: input.url,
    title: input.title,
    stepIndex: String(input.stepIndex),
    stepsLeft: String(input.stepsLeft),
    feedback: input.feedback ? `Note: ${input.feedback}\n` : "",
    history,
    problems,
    outline: input.outline,
    candidates,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => values[k] ?? m);
}

/** Read a decision out of a model's answer. `null` when it is not one. */
export function parseDriveDecision(content: string, candidateCount: number): DriveDecision | null {
  let v: unknown;
  try {
    v = JSON.parse(stripCodeFence(content));
  } catch {
    // A model that wrote prose around the object: take the first {...}.
    const m = /\{[\s\S]*\}/.exec(content);
    if (!m) return null;
    try {
      v = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const reasoning = typeof o.reasoning === "string" ? { reasoning: o.reasoning } : {};
  const index = Number.isInteger(o.index) && (o.index as number) >= 0 && (o.index as number) < candidateCount ? (o.index as number) : undefined;
  switch (o.action) {
    case "done":
    case "give_up":
      return { action: o.action, ...reasoning };
    case "click":
      return index === undefined ? null : { action: "click", index, ...reasoning };
    case "fill":
      return index === undefined || typeof o.value !== "string"
        ? null
        : { action: "fill", index, value: o.value, ...(o.submit === true ? { submit: true } : {}), ...reasoning };
    case "select":
      return index === undefined || typeof o.value !== "string" ? null : { action: "select", index, value: o.value, ...reasoning };
    case "press":
      if (typeof o.key !== "string" || o.key === "") return null;
      return { action: "press", key: o.key, ...(index !== undefined ? { index } : {}), ...reasoning };
    default:
      return null;
  }
}

interface ModelDeciderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Send a screenshot with each step. Default false. */
  vision?: boolean;
  /** Per-call timeout. Default 30 s. */
  timeoutMs?: number;
  maxTokens?: number;
  /** A prompt file in the `---SYSTEM---` / `---USER---` format. */
  promptPath?: string;
  fetch?: typeof globalThis.fetch;
}

export type AnthropicDeciderOptions = ModelDeciderOptions & { anthropicVersion?: string };

export function anthropicDecider(opts: AnthropicDeciderOptions): DriveDecider {
  const model = opts.model ?? "claude-haiku-4-5-20251001";
  const baseUrl = (opts.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
  const httpFetch = opts.fetch ?? globalThis.fetch;
  return {
    name: `anthropic/${model}`,
    async decide(input) {
      const p = loadPrompt(opts.promptPath ?? PROMPT_PATH);
      const content: unknown[] = [];
      if (opts.vision) {
        const shot = await input.screenshot();
        content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: shot.toString("base64") } });
      }
      content.push({ type: "text", text: renderDrivePrompt(p.userTemplate, input) });
      const res = await httpFetch(`${baseUrl}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": opts.anthropicVersion ?? "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: opts.maxTokens ?? 400, system: p.system, messages: [{ role: "user", content }] }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
      if (!res.ok) throw new Error(`anthropic answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      const body = (await res.json()) as { content?: { type?: string; text?: string }[] };
      const text = body.content?.find((b) => b.type === "text")?.text;
      return text === undefined ? null : parseDriveDecision(text, input.candidates.length);
    },
  };
}

export type OpenRouterDeciderOptions = ModelDeciderOptions;

export function openRouterDecider(opts: OpenRouterDeciderOptions): DriveDecider {
  const model = opts.model ?? "google/gemini-2.5-flash";
  const baseUrl = (opts.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const httpFetch = opts.fetch ?? globalThis.fetch;
  return {
    name: `openrouter/${model}`,
    async decide(input) {
      const p = loadPrompt(opts.promptPath ?? PROMPT_PATH);
      const content: unknown[] = [{ type: "text", text: renderDrivePrompt(p.userTemplate, input) }];
      if (opts.vision) {
        const shot = await input.screenshot();
        content.push({ type: "image_url", image_url: { url: `data:image/png;base64,${shot.toString("base64")}` } });
      }
      const res = await httpFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({
          model,
          max_tokens: opts.maxTokens ?? 400,
          messages: [
            { role: "system", content: p.system },
            { role: "user", content },
          ],
        }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
      if (!res.ok) throw new Error(`openrouter answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
      const text = body.choices?.[0]?.message?.content;
      return typeof text === "string" ? parseDriveDecision(text, input.candidates.length) : null;
    },
  };
}

/**
 * One step of a plan. The control is the first candidate whose description
 * matches `target` (a substring, or a RegExp); descriptions read like
 * `button "Sign in" — in form, under "Account"`, so `'button "Sign in"'`
 * pins the role too.
 */
export type DrivePlanStep =
  | { click: string | RegExp }
  | { fill: string | RegExp; value: string; submit?: boolean }
  | { select: string | RegExp; value: string }
  | { press: string; on?: string | RegExp };

/**
 * Follow `steps` in order, then answer `done`. A step whose control is not
 * on the page gives up, naming it: the plan no longer matches the site.
 */
export function planDecider(steps: readonly DrivePlanStep[], name = "plan"): DriveDecider {
  let next = 0;
  return {
    name,
    async decide(input) {
      const step = steps[next];
      if (!step) return { action: "done", reasoning: "the plan is complete" };
      const find = (t: string | RegExp) => input.candidates.find((c) => (typeof t === "string" ? c.description.includes(t) : t.test(c.description)));
      const target = "click" in step ? step.click : "fill" in step ? step.fill : "select" in step ? step.select : step.on;
      const c = target === undefined ? undefined : find(target);
      if (target !== undefined && !c) return { action: "give_up", reasoning: `plan step ${next}: no control matches ${String(target)}` };
      next++;
      const reasoning = `plan step ${next - 1}`;
      if ("click" in step) return { action: "click", index: c!.index, reasoning };
      if ("fill" in step) return { action: "fill", index: c!.index, value: step.value, ...(step.submit ? { submit: true } : {}), reasoning };
      if ("select" in step) return { action: "select", index: c!.index, value: step.value, reasoning };
      return { action: "press", key: step.press, ...(c ? { index: c.index } : {}), reasoning };
    },
  };
}
