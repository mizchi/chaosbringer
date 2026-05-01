/**
 * Pure parsing + rendering for the action-selection prompt asset.
 * The prompt itself lives in `action-selection.md` so it diffs cleanly
 * and can be iterated on without touching code; this module turns that
 * file's contents into a system string and a user-template string.
 */

export interface ParsedPrompt {
  system: string;
  userTemplate: string;
}

export interface UserPromptVars {
  url: string;
  reason: string;
  candidates: string;
  budgetRemaining?: number | string;
}

const SYSTEM_DELIM = "---SYSTEM---";
const USER_DELIM = "---USER---";

export function parsePromptFile(content: string): ParsedPrompt {
  const sysIdx = content.indexOf(SYSTEM_DELIM);
  const userIdx = content.indexOf(USER_DELIM);
  if (sysIdx === -1) {
    throw new Error("prompt file is missing the ---SYSTEM--- delimiter");
  }
  if (userIdx === -1) {
    throw new Error("prompt file is missing the ---USER--- delimiter");
  }
  if (sysIdx > userIdx) {
    throw new Error("prompt file has ---SYSTEM--- after ---USER---");
  }

  const system = content.slice(sysIdx + SYSTEM_DELIM.length, userIdx).trim();
  const userTemplate = content.slice(userIdx + USER_DELIM.length).trimStart();
  return { system, userTemplate: userTemplate.replace(/\s+$/, "") };
}

export function renderUserPrompt(template: string, vars: UserPromptVars): string {
  return template
    .replace(/\{\{url\}\}/g, vars.url)
    .replace(/\{\{reason\}\}/g, vars.reason)
    .replace(/\{\{candidates\}\}/g, vars.candidates)
    .replace(/\{\{budgetRemaining\}\}/g, String(vars.budgetRemaining ?? ""));
}
