/**
 * `report.warnings`: what was set up wrong for the run, as opposed to what
 * the run found.
 *
 * A fault rule that never fired, a `seedFromSitemap` that could not be read,
 * a `network` profile that did not apply, a driver that threw: each made the
 * run test less than it was asked to, and each used to go only to the logger,
 * which writes nowhere unless `logFile` (or `logToConsole`) is set. So a fault
 * test with a typo'd `urlPattern` was a green run. The run still passes with
 * a warning; what changes is that it says so, in the report, the compact and
 * `--quiet` output, the GitHub annotations and `chaos()`'s result, and that
 * `--fail-on-warnings` (`ExitCodeOptions.warnings`) can fail it.
 *
 * Not the pages' console warnings, which are `PageResult.warnings` and
 * `report.totalWarnings`.
 */
import type { FaultLayer } from "./firings.js";

/**
 * Every `RunWarning.code`. Stable across versions, so a caller can route on
 * them; kebab-case `<subject>-<what happened>`.
 *
 * - `fault-unmatched` / `fault-unfired` / `fault-uncounted`: a fault rule of
 *   any layer did not take effect (`unfiredFaults`' three diagnoses, in its
 *   words).
 * - `fault-websocket`: a network rule matched nothing, and its pattern names
 *   WebSocket URLs (only `ws:` / `wss:` ones, or ones the run's pages opened).
 *   Network faults route HTTP requests: Playwright's routes do not see
 *   WebSocket traffic.
 * - `fault-shadowed`: a network rule an earlier one shadows (first match wins).
 * - `server-faults-unseen`: `server: { mode: "remote" }` saw no
 *   `x-chaos-fault-*` header in the whole run.
 * - `sitemap-unreadable` / `sitemap-empty`: `seedFromSitemap` could not be
 *   read, or listed no URL on the crawl's origin.
 * - `network-profile-failed` / `http-cache-disable-failed`: `network` or
 *   `httpCache: false` did not apply to a page.
 * - `driver-threw` / `driver-out-of-range` / `driver-operation-unsupported`:
 *   the driver threw, or picked something the crawler could not do.
 * - `flow-incomplete`: a `flowDriver` journey ended before its last step.
 * - `baseline-missing`: the `baseline` report was not there, so no diff was
 *   made (`chaos()` and the CLI).
 */
export type RunWarningCode =
  | "fault-unmatched"
  | "fault-unfired"
  | "fault-uncounted"
  | "fault-websocket"
  | "fault-shadowed"
  | "server-faults-unseen"
  | "sitemap-unreadable"
  | "sitemap-empty"
  | "network-profile-failed"
  | "http-cache-disable-failed"
  | "driver-threw"
  | "driver-out-of-range"
  | "driver-operation-unsupported"
  | "flow-incomplete"
  | "baseline-missing";

/** `RunWarningCode`'s members, in the order the docs list them. */
export const RUN_WARNING_CODES: readonly RunWarningCode[] = [
  "fault-unmatched",
  "fault-unfired",
  "fault-uncounted",
  "fault-websocket",
  "fault-shadowed",
  "server-faults-unseen",
  "sitemap-unreadable",
  "sitemap-empty",
  "network-profile-failed",
  "http-cache-disable-failed",
  "driver-threw",
  "driver-out-of-range",
  "driver-operation-unsupported",
  "flow-incomplete",
  "baseline-missing",
];

/** One entry of `report.warnings`. */
export interface RunWarning {
  code: RunWarningCode;
  /** One sentence: what did not happen, and what the run did instead. */
  message: string;
  /**
   * How many times it was raised. Identical warnings (the same code and
   * message: a profile that failed on every page) are one entry.
   */
  count: number;
  /** The fault rule's name (`fault-*` codes). */
  rule?: string;
  /** The fault's layer (`fault-*` codes), or `server` (`server-faults-unseen`). */
  layer?: FaultLayer | "server";
  /** The driver's name (`driver-*`, `flow-incomplete`). */
  driver?: string;
  /** The sitemap or baseline it is about: the path or URL as given. */
  source?: string;
  /** The page it was first raised on, for the warnings a page raises. */
  url?: string;
}

/** A warning before it is counted. */
export type RunWarningInput = Omit<RunWarning, "count"> & { count?: number };

const warningKey = (w: Pick<RunWarning, "code" | "message">) => `${w.code}\u0000${w.message}`;

/**
 * Add `warning` to `list` in place, folding it into an identical one (same
 * code and message) by adding to its `count`. The first one's details stay.
 */
export function addRunWarning(list: RunWarning[], warning: RunWarningInput): void {
  const count = warning.count ?? 1;
  const key = warningKey(warning);
  const existing = list.find((w) => warningKey(w) === key);
  if (existing) {
    existing.count += count;
    return;
  }
  list.push({ ...warning, count });
}

/**
 * The warnings of several runs (shards, scan's crawls, flake's runs) as one
 * list: identical ones folded, their counts added, in first-seen order. A
 * missing list (a report an older version wrote) adds nothing.
 */
export function mergeRunWarnings(lists: ReadonlyArray<readonly RunWarning[] | undefined>): RunWarning[] {
  const out: RunWarning[] = [];
  for (const list of lists) {
    for (const w of list ?? []) addRunWarning(out, { ...w, count: typeof w.count === "number" ? w.count : 1 });
  }
  return out;
}

/** ` (×N)` for a warning raised more than once. */
export function warningTimes(w: Pick<RunWarning, "count">): string {
  return w.count > 1 ? ` (×${w.count})` : "";
}

/** The `baseline-missing` warning for `path`. */
export function baselineMissingWarning(path: string): RunWarningInput {
  return {
    code: "baseline-missing",
    message:
      `baseline ${path} not found, so no diff was made: a first run's report is the next one's baseline ` +
      `(--baseline-missing fail / baselineMissing: "fail" refuses the run instead)`,
    source: path,
  };
}

/** What `--baseline-missing` / `baselineMissing` take. */
export type BaselineMissingMode = "warn" | "fail";
export const BASELINE_MISSING_MODES: readonly BaselineMissingMode[] = ["warn", "fail"];
