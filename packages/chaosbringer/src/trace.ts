/**
 * Trace file format. A trace is a JSONL log of everything the crawler did on
 * a run — enough to reconstruct the same sequence of navigations + actions
 * without re-rolling the RNG. Used as input to replay mode and to the
 * `minimize` subcommand.
 *
 * Line 1 is always a `meta` entry; every subsequent line is either a `visit`
 * (the crawler loaded that URL) or an `action` (what it did on the page).
 * Actions are grouped implicitly by the most recent preceding `visit`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { ActionResult } from "./types.js";

/** Incremented when the on-disk layout changes in a way replay cares about. */
export const TRACE_FORMAT_VERSION = 1;

export interface TraceMeta {
  kind: "meta";
  v: number;
  seed: number;
  baseUrl: string;
  /** Epoch ms of the run. Informational only — replay does not use it. */
  startTime: number;
}

export interface TraceVisit {
  kind: "visit";
  url: string;
}

/**
 * A performed action. Mirrors ActionResult but always carries the URL it
 * ran on, which is what replay needs to correlate actions with pages.
 */
export interface TraceAction {
  kind: "action";
  url: string;
  type: ActionResult["type"];
  target?: string;
  selector?: string;
  success: boolean;
  error?: string;
  blockedExternal?: boolean;
  /**
   * When the target was picked by the VLM advisor (not the heuristic),
   * a stamp identifying the provider, the consult reason, and the
   * model's one-line reasoning. Replay uses the recorded `selector` /
   * `target` verbatim — this field is informational only, useful for
   * auditing which actions were model-driven.
   */
  advisor?: {
    provider: string;
    reason: "novelty_stall" | "invariant_violation" | "explicit_request";
    reasoning: string;
  };
}

export type TraceEntry = TraceMeta | TraceVisit | TraceAction;

/**
 * Convert a recorded ActionResult + its URL into a TraceAction. Kept pure so
 * the crawler can serialize without importing node:fs in the hot path.
 */
export function actionToTraceEntry(
  action: ActionResult,
  url: string,
  advisor?: TraceAction["advisor"],
): TraceAction {
  const out: TraceAction = {
    kind: "action",
    url,
    type: action.type,
    success: action.success,
  };
  if (action.target !== undefined) out.target = action.target;
  if (action.selector !== undefined) out.selector = action.selector;
  if (action.error !== undefined) out.error = action.error;
  if (action.blockedExternal !== undefined) out.blockedExternal = action.blockedExternal;
  if (advisor) out.advisor = advisor;
  return out;
}

/** Render a trace as JSONL. Meta must be present and must come first. */
export function serializeTrace(entries: readonly TraceEntry[]): string {
  if (entries.length === 0 || entries[0]!.kind !== "meta") {
    throw new Error("serializeTrace: first entry must be kind=meta");
  }
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

/**
 * Parse JSONL back into entries. Blank lines are ignored; any other malformed
 * line throws — silently skipping would make minimize decisions uninterpretable.
 */
export function parseTrace(raw: string): TraceEntry[] {
  const out: TraceEntry[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(`parseTrace: line ${i + 1} is not valid JSON: ${(err as Error).message}`);
    }
    if (!parsed || typeof parsed !== "object" || !("kind" in parsed)) {
      throw new Error(`parseTrace: line ${i + 1} is missing "kind"`);
    }
    const kind = (parsed as { kind: unknown }).kind;
    if (kind !== "meta" && kind !== "visit" && kind !== "action") {
      throw new Error(`parseTrace: line ${i + 1} has unknown kind ${JSON.stringify(kind)}`);
    }
    out.push(parsed as TraceEntry);
  }
  if (out.length === 0 || out[0]!.kind !== "meta") {
    throw new Error("parseTrace: trace is missing a leading meta entry");
  }
  const meta = out[0] as TraceMeta;
  if (meta.v !== TRACE_FORMAT_VERSION) {
    throw new Error(
      `parseTrace: unsupported trace format v=${meta.v} (this build understands v=${TRACE_FORMAT_VERSION})`
    );
  }
  return out;
}

export function writeTrace(path: string, entries: readonly TraceEntry[]): void {
  writeFileSync(path, serializeTrace(entries));
}

export function readTrace(path: string): TraceEntry[] {
  return parseTrace(readFileSync(path, "utf-8"));
}

/**
 * Group a trace into (visit, actions[]) pairs in encounter order. Useful for
 * replay: each group is one page visit plus the actions performed on it.
 * Actions that appear before any visit (malformed trace) are discarded — the
 * parser already rejects those cases, but double-check here for safety.
 */
export interface TraceGroup {
  url: string;
  actions: TraceAction[];
}

export function groupTrace(entries: readonly TraceEntry[]): TraceGroup[] {
  const groups: TraceGroup[] = [];
  let current: TraceGroup | null = null;
  for (const entry of entries) {
    if (entry.kind === "meta") continue;
    if (entry.kind === "visit") {
      current = { url: entry.url, actions: [] };
      groups.push(current);
    } else if (entry.kind === "action" && current) {
      current.actions.push(entry);
    }
  }
  return groups;
}

export function metaOf(entries: readonly TraceEntry[]): TraceMeta {
  const first = entries[0];
  if (!first || first.kind !== "meta") throw new Error("trace is missing a meta entry");
  return first;
}
