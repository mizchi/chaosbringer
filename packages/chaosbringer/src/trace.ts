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
import { DEFAULT_OPTIONS } from "./defaults.js";
import { ignoreReproFlags } from "./repro-command.js";
import type { ActionResult, CrawlerOptions, NetworkProfile, ReproFlag, SettleMode } from "./types.js";

/**
 * Incremented when the on-disk layout changes in a way replay cares about.
 * v2 added `TraceMeta.setup`, the crawl options that shape a replay.
 */
export const TRACE_FORMAT_VERSION = 2;

/**
 * The versions `parseTrace` reads. A v1 trace has no `setup`, and replays
 * with the options' defaults, as it always did.
 */
export const READABLE_TRACE_VERSIONS: readonly number[] = [1, 2];

export interface TraceMeta {
  kind: "meta";
  v: number;
  seed: number;
  baseUrl: string;
  /** Epoch ms of the run. Informational only — replay does not use it. */
  startTime: number;
  /**
   * The recording crawl's options that change how a replay of it loads,
   * settles and judges its pages (format v2; absent in v1 and when every one
   * was the default). `minimize` replays with them unless a flag overrides.
   */
  setup?: TraceSetup;
}

/**
 * What of a crawl's options a replay needs to see what the crawl saw, each
 * only when it was not the default. Every value is one the crawl was given:
 * patterns, modes and file *paths*. A file's contents (the cookies of a
 * storage state, the bodies of a HAR) are never copied in, and the crawl
 * takes no secret of its own (no `drive --secret`), so a trace holds none.
 * A relative path is as the crawl was given it, so it resolves against the
 * working directory of whoever replays it, as the run's `Repro:` line does.
 */
export interface TraceSetup {
  timeout?: number;
  settle?: SettleMode;
  excludePatterns?: string[];
  ignoreErrorPatterns?: string[];
  ignoreHttpPatterns?: string[];
  spaPatterns?: string[];
  /** `--storage-state`'s path. */
  storageState?: string;
  /** `--har-replay`'s path. A recording (`--har-record`) is no setup to replay with. */
  harReplay?: string;
  device?: string;
  network?: NetworkProfile;
  /** `false` for `--no-http-cache`. */
  httpCache?: false;
  /**
   * The `--invariants` / `--data-safety` presets, as one canonical
   * `--invariants` value. An invariant set in code is a closure, which no
   * trace can hold: it is not recorded.
   */
  invariants?: string;
  /** `--axe` (or `--invariants axe`), with its `--axe-tags`. */
  axe?: { tags?: string };
}

/**
 * The `TraceSetup` of a crawl's options; `undefined` when nothing in it
 * differs from the defaults. The CLI's invariants are read off
 * `cliReproFlags`, which is how `reproCommand` carries them too.
 */
export function traceSetupOf(options: CrawlerOptions): TraceSetup | undefined {
  const setup: TraceSetup = {};
  if (options.timeout !== undefined && options.timeout !== DEFAULT_OPTIONS.timeout) setup.timeout = options.timeout;
  if (options.settle !== undefined && options.settle !== DEFAULT_OPTIONS.settle) setup.settle = options.settle;
  const list = (v: readonly string[] | undefined) => (v && v.length > 0 ? [...v] : undefined);
  const lists = {
    excludePatterns: list(options.excludePatterns),
    ignoreErrorPatterns: list(options.ignoreErrorPatterns),
    ignoreHttpPatterns: list(options.ignoreHttpPatterns),
    spaPatterns: list(options.spaPatterns),
  };
  for (const [key, value] of Object.entries(lists)) if (value) setup[key as keyof typeof lists] = value;
  if (typeof options.storageState === "string" && options.storageState !== "") setup.storageState = options.storageState;
  if (options.har?.mode === "replay") setup.harReplay = options.har.path;
  if (options.device) setup.device = options.device;
  if (options.network) setup.network = options.network;
  if (options.httpCache === false) setup.httpCache = false;
  for (const { flag, value } of options.cliReproFlags ?? []) {
    if (flag === "--invariants" && value) setup.invariants = value;
    if (flag === "--axe") setup.axe = { ...setup.axe };
    if (flag === "--axe-tags" && value !== undefined) setup.axe = { ...setup.axe, tags: value };
  }
  return Object.keys(setup).length > 0 ? setup : undefined;
}

/**
 * A `TraceSetup` as the crawl flags that build it, in the main crawl's
 * spelling (`--ignore-preset analytics` for that preset's patterns, as the
 * `Repro:` line writes them): `minimize` parses them with the same table as
 * its own flags, and prints them as what it applied.
 */
export function traceSetupFlags(setup: TraceSetup | undefined): ReproFlag[] {
  if (!setup) return [];
  const out: ReproFlag[] = [];
  const push = (flag: string, value?: string) => out.push(value === undefined ? { flag } : { flag, value });
  if (setup.timeout !== undefined) push("--timeout", String(setup.timeout));
  if (setup.settle !== undefined) push("--settle", String(setup.settle));
  for (const p of setup.excludePatterns ?? []) push("--exclude", p);
  out.push(...ignoreReproFlags(setup.ignoreErrorPatterns ?? []));
  for (const p of setup.ignoreHttpPatterns ?? []) push("--ignore-http", p);
  for (const p of setup.spaPatterns ?? []) push("--spa", p);
  if (setup.storageState !== undefined) out.push({ flag: "--storage-state", value: setup.storageState, path: true });
  if (setup.harReplay !== undefined) out.push({ flag: "--har-replay", value: setup.harReplay, path: true });
  if (setup.device !== undefined) push("--device", setup.device);
  if (setup.network !== undefined) push("--network", setup.network);
  if (setup.httpCache === false) push("--no-http-cache");
  if (setup.invariants !== undefined) push("--invariants", setup.invariants);
  if (setup.axe) {
    push("--axe");
    if (setup.axe.tags !== undefined) push("--axe-tags", setup.axe.tags);
  }
  return out;
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
    /**
     * How sure the picker said it was, 0..1, when it reported it. Worth
     * auditing: a run that went wrong usually said so at the time, and the
     * low-confidence picks are where it started.
     */
    confidence?: number;
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
  if (!READABLE_TRACE_VERSIONS.includes(meta.v)) {
    throw new Error(
      `parseTrace: unsupported trace format v=${meta.v} (this build understands v=${READABLE_TRACE_VERSIONS.join(", v=")})`
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
