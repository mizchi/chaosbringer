/**
 * Decide whether a `wrangler dev` log is clean enough to call the run a pass.
 *
 * workerd prints every error that escapes a Worker as `Uncaught ...`, and
 * the issue asks that none of them be treated as success. Two kinds are
 * printed in every Kitesurf session whether or not a fault is involved, and a
 * few are the faults themselves, so a bare "no Uncaught" rule cannot pass.
 * Each line that looks like an error has to be one of the following, or the
 * run fails:
 *
 * - `script terminated for unknown reasons`: Kitesurf tears down the page
 *   isolate on every navigation and on socket close (`[ks-kill] ...
 *   generation bump` / `engine WS closed`), and workerd reports the killed
 *   context this way.
 * - `Uncaught Error: Network connection lost.`: printed (and echoed by
 *   `[kitesurf-ws] post-close async settled`) when a CDP socket closes.
 * - The injected-abort marker: an `abort` fault is an error thrown through
 *   the Service Binding, and workerd logs it up to three times plus
 *   Kitesurf's `fetch network error` line. Allowed only when the stats say an
 *   abort was injected, and required when they do: a marker without an
 *   injection, or an injection without a marker, means something else failed.
 * - `run-lost: <id>`: only for runs the scenario deleted on purpose.
 * - The disposed-session error: only when a dispose cut a request short.
 * - The caller-cancelled marker: only when the host counted a call whose
 *   caller (the engine's deadline, a closed socket) went away mid-delay.
 *
 * The allowlist is tied to the pinned Kitesurf revision
 * (kitesurf-revision.json); a new pin has to re-check it.
 */

import { INJECTED_ABORT_MARKER } from "@mizchi/kitesurf-faults";

/** Message of `KitesurfFaultsError("disposed")`; see packages/kitesurf-faults/src/egress.ts. */
export const DISPOSED_MARKER = "kitesurf-faults: the fault egress session is disposed";

/**
 * Message the host rethrows a caller's cancellation under (src/host.ts).
 * workerd logs the rejection of a cancelled call, and with the bare abort
 * reason the line is just `Uncaught  `, which nothing could attribute.
 */
export const CALLER_CANCELLED_MARKER = "kitesurf-faults example: the caller cancelled the request";

export interface LogGateOptions {
  /** Sum of `injected` over every abort rule of every run. */
  injectedAborts: number;
  /** Runs a scenario removed on purpose while their socket was open. */
  runLostIds?: readonly string[];
  /** Requests a dispose aborted while they were still in flight. */
  disposedInFlight?: number;
  /** Calls whose Request.signal fired while the session held them. */
  callerCancelled?: number;
}

export interface LogGateResult {
  ok: boolean;
  /** Error-looking lines matched by nothing below (ANSI stripped). */
  unexpected: string[];
  injectedAbortLines: number;
  runLostLines: number;
  disposedLines: number;
  callerCancelledLines: number;
  /** Count per always-allowed category. */
  allowlisted: Record<string, number>;
  /** Why the gate failed, other than `unexpected`. */
  reasons: string[];
}

// wrangler colours its output; ESC is the point of this pattern.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const ERRORISH = /Uncaught|✘ \[ERROR\]|\bError:/;
// Not an error line, but the sign of a wait that outlived its request: the
// spike saw it when a host dispose reached a call workerd had already
// cancelled. A clean run never prints it.
const CROSS_CONTEXT = /different request context/;

const ALWAYS_ALLOWED: ReadonlyArray<readonly [category: string, needle: string]> = [
  ["page-isolate-teardown", "script terminated for unknown reasons"],
  ["cdp-close", "Uncaught Error: Network connection lost."],
];

export function classifyWorkerdLog(text: string, options: LogGateOptions): LogGateResult {
  const runLostIds = new Set(options.runLostIds ?? []);
  const result: LogGateResult = {
    ok: false,
    unexpected: [],
    injectedAbortLines: 0,
    runLostLines: 0,
    disposedLines: 0,
    callerCancelledLines: 0,
    allowlisted: {},
    reasons: [],
  };

  for (const raw of text.split("\n")) {
    const line = raw.replace(ANSI, "").trimEnd();
    if (CROSS_CONTEXT.test(line)) {
      result.unexpected.push(line);
      continue;
    }
    if (!ERRORISH.test(line)) continue;

    const allowed = ALWAYS_ALLOWED.find(([, needle]) => line.includes(needle));
    if (allowed) {
      result.allowlisted[allowed[0]] = (result.allowlisted[allowed[0]] ?? 0) + 1;
      continue;
    }
    if (line.includes(INJECTED_ABORT_MARKER)) {
      result.injectedAbortLines++;
      continue;
    }
    if (line.includes(DISPOSED_MARKER) && (options.disposedInFlight ?? 0) > 0) {
      result.disposedLines++;
      continue;
    }
    if (line.includes(CALLER_CANCELLED_MARKER) && (options.callerCancelled ?? 0) > 0) {
      result.callerCancelledLines++;
      continue;
    }
    // The id ends at whitespace or the end of the line, so `r-lost` does not
    // also cover `r-lost-2`.
    const lost = /run-lost: (\S+)/.exec(line);
    if (lost && runLostIds.has(lost[1]!)) {
      result.runLostLines++;
      continue;
    }
    result.unexpected.push(line);
  }

  if (text.trim() === "") result.reasons.push("the workerd log is empty: it was not captured");
  if (result.injectedAbortLines > 0 && options.injectedAborts === 0) {
    result.reasons.push(`${result.injectedAbortLines} injected-abort lines without an injected abort in the stats`);
  }
  if (options.injectedAborts > 0 && result.injectedAbortLines === 0) {
    result.reasons.push(`the stats injected ${options.injectedAborts} abort(s) but the log has no injected-abort line`);
  }
  if (result.unexpected.length > 0) result.reasons.push(`${result.unexpected.length} unexpected error line(s)`);
  result.ok = result.reasons.length === 0;
  return result;
}
