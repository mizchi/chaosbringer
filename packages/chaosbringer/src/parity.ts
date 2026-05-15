/**
 * Non-random parity probe. For each path in a list, fetch the same path
 * against two base URLs and surface differences in status, redirect
 * target, request failure, and (opt-in) response-body content. This is
 * the routing-bug detection mode — when random crawls find too much
 * third-party noise, a deterministic same-path probe across two
 * runtimes pinpoints where the routes actually disagree.
 *
 * Scope: HTTP request-level (status, Location, fetch failures) is
 * always-on. Body-content drift is opt-in via `checkBody` because the
 * body fetch doubles the work per probe and most consumers care first
 * about status. JavaScript exceptions still need a Playwright session
 * per probe and are deferred.
 */

import { createHash } from "node:crypto";

export type MismatchKind =
  /** HTTP status codes differ. */
  | "status"
  /** One side redirected to a different Location than the other. */
  | "redirect"
  /** fetch() threw on one side and succeeded on the other. */
  | "failure"
  /**
   * Status agreed but the response body bytes differ. Only fires when
   * `checkBody` is enabled in the run options.
   */
  | "body";

export interface SideResult {
  /** Final status. `null` when the fetch threw before getting a response. */
  status: number | null;
  /** Redirect target for 3xx responses, when present. */
  location?: string | null;
  /** Captured fetch error message when the request threw. */
  error?: string;
  /**
   * Response body size in bytes. Populated only when `checkBody` is
   * enabled. Lets a consumer of the JSON report see at a glance how
   * different the two sides are without needing to refetch.
   */
  bodyLength?: number;
  /**
   * SHA-256 of the raw body bytes, lowercase hex. Populated only when
   * `checkBody` is enabled. Used by `classify()` to detect drift; also
   * carried in the JSON report so consumers can tell whether the
   * mismatch reproduces across reruns (same pair of hashes → real
   * drift, not flakiness).
   */
  bodyHash?: string;
}

export interface ParityProbe {
  path: string;
  left: SideResult;
  right: SideResult;
}

export interface ParityMismatch extends ParityProbe {
  /** Mismatch kinds detected for this probe. A single probe can carry
   *  multiple kinds (e.g. left fails + right returns 200 → both
   *  "failure" and "status" depending on the consumer's view; we record
   *  the strongest one). */
  kind: MismatchKind;
}

export interface ParityReport {
  left: string;
  right: string;
  pathsChecked: number;
  mismatches: ParityMismatch[];
  /** Paths that agreed on every comparison. Carried so consumers can
   *  prove which routes are stable without re-running. */
  matches: ParityProbe[];
}

export interface RunParityOptions {
  left: string;
  right: string;
  paths: string[];
  /**
   * When `true`, fetch follows redirects and the comparison uses the
   * final status. When `false` (the default), `redirect: "manual"`
   * is used so 3xx and the Location header are compared directly —
   * the more sensitive mode for routing-bug detection.
   */
  followRedirects?: boolean;
  /**
   * Per-request timeout in ms. Defaults to 10s. Applied to each side
   * independently; one slow side does not stall the other.
   */
  timeoutMs?: number;
  /**
   * When `true`, the body of each response is read and compared by
   * SHA-256 hash. Adds one full body read per side per path, so it's
   * opt-in. Required to catch silent schema drift like a missing JSON
   * field that doesn't move the status code.
   */
  checkBody?: boolean;
  /** Override fetch for testing. */
  fetcher?: typeof fetch;
}

function joinBase(base: string, path: string): string {
  // Both `<base>/foo` and `<base>foo` are common in path files. Normalise
  // so we never double-slash or miss-slash. URL parses both cleanly.
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

async function probeSide(
  base: string,
  path: string,
  opts: {
    followRedirects: boolean;
    timeoutMs: number;
    fetcher: typeof fetch;
    checkBody: boolean;
  },
): Promise<SideResult> {
  const url = joinBase(base, path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const resp = await opts.fetcher(url, {
      redirect: opts.followRedirects ? "follow" : "manual",
      signal: controller.signal,
    });
    const result: SideResult = {
      status: resp.status,
      location: resp.headers.get("location"),
    };
    if (opts.checkBody) {
      // Reading the body is part of the same timeout window — a slow
      // body trickle counts against the per-request budget so one
      // stuck side can't stall the report indefinitely. Hash on the
      // raw bytes (not decoded text) so binary responses work without
      // a content-type-aware decoder.
      const bytes = new Uint8Array(await resp.arrayBuffer());
      result.bodyLength = bytes.byteLength;
      result.bodyHash = createHash("sha256").update(bytes).digest("hex");
    }
    return result;
  } catch (err) {
    return {
      status: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function classify(left: SideResult, right: SideResult): MismatchKind | null {
  const leftFailed = left.status === null;
  const rightFailed = right.status === null;
  if (leftFailed !== rightFailed) return "failure";
  if (leftFailed && rightFailed) {
    // Both failed — not a parity mismatch per the feature request
    // ("only one side fails"), so treat as a match. The caller can
    // still see both error strings via the probe data if needed.
    return null;
  }
  if (left.status !== right.status) return "status";
  // Status matched. For 3xx, also check the redirect target.
  if (
    typeof left.status === "number" &&
    left.status >= 300 &&
    left.status < 400 &&
    left.location !== right.location
  ) {
    return "redirect";
  }
  // Body comparison is opt-in (gated by `checkBody`) — both hashes
  // are only populated when the caller asked for it, so a missing
  // hash on either side disables this branch automatically.
  if (
    left.bodyHash !== undefined &&
    right.bodyHash !== undefined &&
    left.bodyHash !== right.bodyHash
  ) {
    return "body";
  }
  return null;
}

export async function runParity(opts: RunParityOptions): Promise<ParityReport> {
  const followRedirects = opts.followRedirects ?? false;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const fetcher = opts.fetcher ?? fetch;
  const checkBody = opts.checkBody ?? false;

  const mismatches: ParityMismatch[] = [];
  const matches: ParityProbe[] = [];

  for (const path of opts.paths) {
    // Probe both sides in parallel — they're independent and the report
    // is symmetric, so there's no reason to serialise.
    const sideOpts = { followRedirects, timeoutMs, fetcher, checkBody };
    const [left, right] = await Promise.all([
      probeSide(opts.left, path, sideOpts),
      probeSide(opts.right, path, sideOpts),
    ]);
    const probe: ParityProbe = { path, left, right };
    const kind = classify(left, right);
    if (kind) mismatches.push({ ...probe, kind });
    else matches.push(probe);
  }

  return {
    left: opts.left,
    right: opts.right,
    pathsChecked: opts.paths.length,
    mismatches,
    matches,
  };
}
