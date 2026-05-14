/**
 * Parsing + rendering for the driver-step prompt asset. The prompt lives
 * as a separate `.md` file so it diffs cleanly and can be tweaked
 * without touching code.
 */
import type { DriverHistoryEntry, DriverInvariantViolation, DriverProviderInput } from "../types.js";

export interface ParsedPrompt {
  system: string;
  userTemplate: string;
}

const SYSTEM_DELIM = "---SYSTEM---";
const USER_DELIM = "---USER---";

export function parsePromptFile(content: string): ParsedPrompt {
  const sysIdx = content.indexOf(SYSTEM_DELIM);
  const userIdx = content.indexOf(USER_DELIM);
  if (sysIdx === -1) throw new Error("prompt file is missing the ---SYSTEM--- delimiter");
  if (userIdx === -1) throw new Error("prompt file is missing the ---USER--- delimiter");
  if (sysIdx > userIdx) throw new Error("prompt file has ---SYSTEM--- after ---USER---");
  const system = content.slice(sysIdx + SYSTEM_DELIM.length, userIdx).trim();
  const userTemplate = content.slice(userIdx + USER_DELIM.length).trimStart();
  return { system, userTemplate: userTemplate.replace(/\s+$/, "") };
}

export function formatHistory(history: ReadonlyArray<DriverHistoryEntry>): string {
  if (history.length === 0) return "(none)";
  return history
    .map((h, i) => {
      const status = h.success ? "ok" : `fail: ${h.error ?? "unknown"}`;
      return `${i + 1}. ${h.type} ${h.target ?? "?"} — ${status}`;
    })
    .join("\n");
}

export function formatViolations(violations: ReadonlyArray<DriverInvariantViolation>): string {
  if (violations.length === 0) return "(none)";
  return violations.map((v) => `- ${v.name}: ${v.message}`).join("\n");
}

export function formatCandidates(candidates: ReadonlyArray<{ index: number; description: string }>): string {
  return candidates.map((c) => `${c.index}. ${c.description}`).join("\n");
}

export function renderUserPrompt(template: string, input: DriverProviderInput): string {
  const goalLine = input.goal ? `Goal: ${input.goal}\n` : "";
  return template
    .replace(/\{\{url\}\}/g, input.url)
    .replace(/\{\{stepIndex\}\}/g, String(input.stepIndex))
    .replace(/\{\{goalLine\}\}/g, goalLine)
    .replace(/\{\{history\}\}/g, formatHistory(input.history))
    .replace(/\{\{violations\}\}/g, formatViolations(input.invariantViolations))
    .replace(/\{\{candidates\}\}/g, formatCandidates(input.candidates));
}

export function stripCodeFence(s: string): string {
  const trimmed = s.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

export interface RawSuggestion {
  index: number;
  reasoning: string;
  confidence?: number;
}

export function parseSuggestion(content: string, candidateCount: number): RawSuggestion | null {
  let value: unknown;
  try {
    value = JSON.parse(stripCodeFence(content));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  // Accept either {index} (new) or {chosenIndex} (legacy advisor prompt) for
  // compatibility with prompt iterations.
  const rawIdx = Number.isInteger(obj.index) ? (obj.index as number)
    : Number.isInteger(obj.chosenIndex) ? (obj.chosenIndex as number)
    : null;
  if (rawIdx === null) return null;
  if (rawIdx < 0 || rawIdx >= candidateCount) return null;
  if (typeof obj.reasoning !== "string") return null;
  const out: RawSuggestion = { index: rawIdx, reasoning: obj.reasoning };
  if (typeof obj.confidence === "number") out.confidence = obj.confidence;
  return out;
}
