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
import { diffJsonBodies, type BodyDiffResult } from "./body-diff.js";

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
  | "body"
  /**
   * Status agreed but one or more of the named response headers
   * differ. Only fires when `checkHeaders` is non-empty.
   */
  | "header"
  /**
   * Status / body / headers all agreed (or weren't checked) but a
   * browser visit to one side surfaced JavaScript errors the other
   * side did not — uncaught exceptions, console.error, hydration
   * mismatches. The bug class that's invisible to HTTP-layer probes.
   * Only fires when `checkExceptions` is enabled.
   */
  | "exception"
  /**
   * Right was slower than left by more than the configured budget.
   * Single-sample wall-clock — noisy by nature, so the threshold
   * (`perfDeltaMs` and/or `perfRatio`) must be set explicitly. Pair
   * with N-sample sweeping at the call site if you need percentiles.
   */
  | "perf";

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
  /**
   * Named response headers, lowercased and de-duplicated. Populated
   * only for headers listed in `checkHeaders`. A header that was
   * absent on a given side appears as `null`, so consumers can
   * distinguish "missing" from "empty".
   */
  headers?: Record<string, string | null>;
  /**
   * Uncaught page errors (`window.onerror` / Playwright's `pageerror`
   * event) captured during a browser visit. Populated only when
   * `checkExceptions` is enabled.
   */
  pageErrors?: string[];
  /**
   * `console.error` lines captured during a browser visit. Populated
   * only when `checkExceptions` is enabled. Console *warnings* are
   * deliberately ignored — chaosbringer's crawler does the same.
   */
  consoleErrors?: string[];
  /**
   * Wall-clock duration of the fetch, in milliseconds. Populated on
   * every successful probe (free — we already have the start time
   * before fetch). `undefined` when the probe failed before
   * timing could be meaningful (DNS error, connection refused).
   */
  durationMs?: number;
}

export interface ParityProbe {
  path: string;
  left: SideResult;
  right: SideResult;
}

export interface ParityMismatch extends ParityProbe {
  /**
   * All mismatch kinds detected for this probe, ordered by precedence
   * (status / failure → header → body → exception). Empty array can't
   * happen — a probe with no detected drift goes into `matches`
   * instead.
   *
   * Where a previous version exposed `kind: MismatchKind`, callers
   * should use `kinds[0]` for the primary signal — but `kinds` lets
   * a triager see ALL coexisting bugs at once (header + body + body
   * shape all firing on the same path). Hiding the body drift behind
   * the header drift was the bug.
   */
  kinds: MismatchKind[];
  /**
   * Localised body diff. Populated when `kinds` contains `"body"` and
   * both sides' bodies parsed as JSON. Carries up to ~50 path-level
   * entries; a truncated flag fires when the diff overflows.
   */
  bodyDiff?: BodyDiffResult;
}

/**
 * Bumped when the report shape changes in a non-backwards-compatible
 * way. Downstream consumers (dashboards, CI scripts, the agent loop)
 * can reject reports of an unexpected version rather than silently
 * mis-reading a renamed field. Additive changes (new optional fields,
 * new `MismatchKind` values) do NOT bump this — they're behind
 * opt-in flags.
 */
export const PARITY_REPORT_SCHEMA_VERSION = 1;

export interface ParityReport {
  /** Stable integer. See `PARITY_REPORT_SCHEMA_VERSION`. */
  schemaVersion: number;
  left: string;
  right: string;
  pathsChecked: number;
  mismatches: ParityMismatch[];
  /** Paths that agreed on every comparison. Carried so consumers can
   *  prove which routes are stable without re-running. */
  matches: ParityProbe[];
  /**
   * The threshold + opt-in switches that produced this report. An
   * operator re-reading the JSON can tell at a glance which checks
   * were on, and which threshold a `perf` mismatch tripped against.
   * Re-running with a different config produces a different report —
   * the config is part of the result, not external state.
   */
  config: {
    checkBody: boolean;
    checkHeaders: string[];
    checkExceptions: boolean;
    followRedirects: boolean;
    timeoutMs: number;
    perfDeltaMs?: number;
    perfRatio?: number;
  };
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
  /**
   * Header names to compare. Case-insensitive; lowercased internally
   * and matched against the response's header bag. When empty (the
   * default) no header comparison is done — headers vary too much
   * between requests for an unconditional check to be useful.
   *
   * Typical opt-ins: `["content-type", "cache-control", "set-cookie",
   * "access-control-allow-origin"]`. The list is the caller's policy;
   * we don't ship defaults so each consumer is forced to think about
   * which headers actually matter to their app.
   */
  checkHeaders?: string[];
  /**
   * When `true`, each path is also visited in a real browser (Chromium)
   * and uncaught page errors + `console.error` are recorded. The
   * comparison fires "exception" when the captured error sets differ
   * between sides — catches React hydration mismatches and other
   * runtime-only failures where HTTP looks identical.
   *
   * Cost is dominant: one browser visit per side per path is orders
   * of magnitude slower than the fetch probe. Browsers are reused
   * across paths via a single launch; per-path isolation comes from
   * a fresh `BrowserContext`.
   *
   * Playwright is loaded via dynamic import only when this is set,
   * so consumers that don't opt in do not pay the install cost.
   */
  checkExceptions?: boolean;
  /**
   * Flag a `perf` mismatch when `right.durationMs - left.durationMs`
   * exceeds this many milliseconds. Off when unset / 0. Single-sample
   * wall-clock is noisy by nature — set the budget well above your
   * jitter floor, or run multiple sweeps and check the percentile
   * yourself. We don't ship N-sampling here because the right N is
   * caller-specific.
   */
  perfDeltaMs?: number;
  /**
   * Flag a `perf` mismatch when `right.durationMs > left.durationMs * ratio`.
   * Off when unset / 0 or when either side's duration is 0 (avoids
   * divide-by-zero noise on instantly-cached responses). Composes with
   * `perfDeltaMs` via OR — either threshold tripping fires the
   * mismatch.
   */
  perfRatio?: number;
  /** Override fetch for testing. */
  fetcher?: typeof fetch;
  /**
   * Override the browser launcher for testing. The default lazy-loads
   * `playwright.chromium.launch()`. A test can pass a fake that
   * produces canned `pageErrors` / `consoleErrors` per URL without
   * actually starting Chromium.
   */
  browserLauncher?: () => Promise<BrowserLike>;
}

// ─── Browser abstraction (minimal subset of Playwright Page used here)
//
// The real `Browser` / `Page` types come from `playwright` and are huge.
// We declare only the slice the parity probe actually touches, so test
// doubles stay tiny and the integration boundary stays explicit.

export interface PageLike {
  on(event: "pageerror", handler: (err: Error) => void): void;
  on(event: "console", handler: (msg: ConsoleMessageLike) => void): void;
  goto(url: string, opts?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  waitForLoadState?(
    state: string,
    opts?: { timeout?: number },
  ): Promise<void>;
}
interface ConsoleMessageLike {
  type(): string;
  text(): string;
}
export interface ContextLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}
export interface BrowserLike {
  newContext(): Promise<ContextLike>;
  close(): Promise<void>;
}

function joinBase(base: string, path: string): string {
  // Both `<base>/foo` and `<base>foo` are common in path files. Normalise
  // so we never double-slash or miss-slash. URL parses both cleanly.
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

/**
 * Normalise an error message so two runs of the same bug collapse into
 * the same string. Mirrors `clusterErrors`'s fingerprint logic but kept
 * inline so parity stays free of a cross-module dependency on the
 * crawler.
 */
function fingerprintErrorMessage(msg: string): string {
  return msg
    .replace(/https?:\/\/[^\s"'()<>]+/g, "<url>")
    .replace(/:\d+:\d+/g, ":<loc>")
    .replace(/\b\d{3,}\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

async function probeBrowserSide(
  browser: BrowserLike,
  url: string,
  timeoutMs: number,
): Promise<{ pageErrors: string[]; consoleErrors: string[] }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  try {
    await page.goto(url, { timeout: timeoutMs, waitUntil: "load" });
    // Best-effort idle wait so async errors (post-load fetch failures,
    // micro-task throwers) surface before we tear the page down. The
    // catch swallows the inevitable timeout on apps that never idle.
    if (page.waitForLoadState) {
      await page.waitForLoadState("networkidle", { timeout: 1000 }).catch(() => {
        // ignored: networkidle didn't settle within 1s — fine, we have what we have
      });
    }
  } catch {
    // Navigation errors (DNS, connection refused, etc.) are already
    // reported by the fetch probe via the "failure" kind. We don't
    // double-report them here.
  } finally {
    await ctx.close();
  }
  return { pageErrors, consoleErrors };
}

interface ProbedSide {
  result: SideResult;
  /**
   * Raw decoded body text. Kept transient (not on SideResult) so the
   * JSON report doesn't balloon with full bodies; only the body-diff
   * (computed from this) gets serialised. `null` when the body wasn't
   * read (checkBody off).
   */
  bodyText: string | null;
}

async function probeSide(
  base: string,
  path: string,
  opts: {
    followRedirects: boolean;
    timeoutMs: number;
    fetcher: typeof fetch;
    checkBody: boolean;
    checkHeaders: string[];
  },
): Promise<ProbedSide> {
  const url = joinBase(base, path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  // Wall-clock timer wraps the full fetch including body read (when
  // `checkBody` is on) — a slow-body side should NOT look faster than
  // a fast-body one just because we stopped measuring at headers.
  const startedAt = performance.now();
  try {
    const resp = await opts.fetcher(url, {
      redirect: opts.followRedirects ? "follow" : "manual",
      signal: controller.signal,
    });
    const result: SideResult = {
      status: resp.status,
      location: resp.headers.get("location"),
    };
    if (opts.checkHeaders.length > 0) {
      const out: Record<string, string | null> = {};
      for (const name of opts.checkHeaders) {
        out[name] = resp.headers.get(name);
      }
      result.headers = out;
    }
    let bodyText: string | null = null;
    if (opts.checkBody) {
      // Reading the body is part of the same timeout window — a slow
      // body trickle counts against the per-request budget so one
      // stuck side can't stall the report indefinitely. Hash on the
      // raw bytes (not decoded text) so binary responses work without
      // a content-type-aware decoder.
      const bytes = new Uint8Array(await resp.arrayBuffer());
      result.bodyLength = bytes.byteLength;
      result.bodyHash = createHash("sha256").update(bytes).digest("hex");
      bodyText = new TextDecoder().decode(bytes);
    }
    result.durationMs = performance.now() - startedAt;
    return { result, bodyText };
  } catch (err) {
    return {
      result: {
        status: null,
        error: err instanceof Error ? err.message : String(err),
      },
      bodyText: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

interface ClassifyOptions {
  perfDeltaMs?: number;
  perfRatio?: number;
}

/**
 * Detect every mismatch kind applicable to a (left, right) probe pair.
 * Returns the kinds in precedence order so `kinds[0]` is the primary
 * signal — but a triager with the full list sees overlapping bugs
 * (e.g. header drift AND body drift on the same path) at once.
 *
 * Failure / status / redirect are still exclusive at the top of the
 * chain: a connection-level or status-level difference means the
 * downstream body/header inspection is comparing apples to oranges.
 * Once those pass, header / body / exception / perf can ALL fire and
 * each gets reported.
 */
function classify(
  left: SideResult,
  right: SideResult,
  opts: ClassifyOptions = {},
): MismatchKind[] {
  const leftFailed = left.status === null;
  const rightFailed = right.status === null;
  if (leftFailed !== rightFailed) return ["failure"];
  if (leftFailed && rightFailed) return []; // both failed → matched per spec
  if (left.status !== right.status) return ["status"];
  if (
    typeof left.status === "number" &&
    left.status >= 300 &&
    left.status < 400 &&
    left.location !== right.location
  ) {
    return ["redirect"];
  }

  const kinds: MismatchKind[] = [];
  if (left.headers && right.headers) {
    for (const name of Object.keys(left.headers)) {
      if (left.headers[name] !== right.headers[name]) {
        kinds.push("header");
        break;
      }
    }
  }
  if (
    left.bodyHash !== undefined &&
    right.bodyHash !== undefined &&
    left.bodyHash !== right.bodyHash
  ) {
    kinds.push("body");
  }
  if (left.pageErrors && right.pageErrors) {
    const leftFp = new Set([
      ...left.pageErrors.map(fingerprintErrorMessage),
      ...(left.consoleErrors ?? []).map(fingerprintErrorMessage),
    ]);
    const rightFp = new Set([
      ...right.pageErrors.map(fingerprintErrorMessage),
      ...(right.consoleErrors ?? []).map(fingerprintErrorMessage),
    ]);
    let differs = leftFp.size !== rightFp.size;
    if (!differs) {
      for (const fp of leftFp) {
        if (!rightFp.has(fp)) {
          differs = true;
          break;
        }
      }
    }
    if (differs) kinds.push("exception");
  }
  // Perf comparison is OR-of-thresholds: either passing fires the
  // mismatch. Skipped silently when either side has no duration
  // (probe failed before timing was meaningful) or when no threshold
  // is configured — leaves single-sample latency noise off by default.
  if (
    typeof left.durationMs === "number" &&
    typeof right.durationMs === "number" &&
    ((opts.perfDeltaMs && opts.perfDeltaMs > 0 && right.durationMs - left.durationMs > opts.perfDeltaMs) ||
      (opts.perfRatio &&
        opts.perfRatio > 0 &&
        left.durationMs > 0 &&
        right.durationMs > left.durationMs * opts.perfRatio))
  ) {
    kinds.push("perf");
  }
  return kinds;
}

async function defaultBrowserLauncher(): Promise<BrowserLike> {
  // Dynamic import keeps Playwright off the import graph for users
  // who never enable `checkExceptions`. TS doesn't follow the dynamic
  // string into the package, so we narrow to BrowserLike at runtime.
  const pw = await import("playwright");
  const browser = await pw.chromium.launch({ headless: true });
  return browser as unknown as BrowserLike;
}

export async function runParity(opts: RunParityOptions): Promise<ParityReport> {
  const followRedirects = opts.followRedirects ?? false;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const fetcher = opts.fetcher ?? fetch;
  const checkBody = opts.checkBody ?? false;
  // Normalise header names to lowercase up front so the comparison
  // can use `Headers.get()` (which is case-insensitive anyway) and
  // the result map is keyed predictably for downstream consumers.
  const checkHeaders = (opts.checkHeaders ?? []).map((h) => h.toLowerCase());
  const checkExceptions = opts.checkExceptions ?? false;

  // Browser launch is amortised across all paths — one Chromium for
  // the whole run, fresh context per visit. Only fires when
  // checkExceptions is enabled so non-browser runs stay zero-cost.
  let browser: BrowserLike | null = null;
  if (checkExceptions) {
    const launcher = opts.browserLauncher ?? defaultBrowserLauncher;
    browser = await launcher();
  }

  const mismatches: ParityMismatch[] = [];
  const matches: ParityProbe[] = [];

  try {
    for (const path of opts.paths) {
      // Probe both sides in parallel — they're independent and the report
      // is symmetric, so there's no reason to serialise.
      const sideOpts = { followRedirects, timeoutMs, fetcher, checkBody, checkHeaders };
      const [leftProbe, rightProbe] = await Promise.all([
        probeSide(opts.left, path, sideOpts),
        probeSide(opts.right, path, sideOpts),
      ]);
      const left = leftProbe.result;
      const right = rightProbe.result;

      if (browser) {
        // Browser visits are slower (~1s+ per page) and must use real
        // resolution against the live server. Serial per-side to avoid
        // hammering one server; parallel across sides for symmetry.
        const [bLeft, bRight] = await Promise.all([
          probeBrowserSide(browser, joinBase(opts.left, path), timeoutMs),
          probeBrowserSide(browser, joinBase(opts.right, path), timeoutMs),
        ]);
        left.pageErrors = bLeft.pageErrors;
        left.consoleErrors = bLeft.consoleErrors;
        right.pageErrors = bRight.pageErrors;
        right.consoleErrors = bRight.consoleErrors;
      }

      const probe: ParityProbe = { path, left, right };
      const kinds = classify(left, right, {
        perfDeltaMs: opts.perfDeltaMs,
        perfRatio: opts.perfRatio,
      });
      if (kinds.length > 0) {
        const m: ParityMismatch = { ...probe, kinds };
        // Localise body drift to specific JSON paths when both sides
        // carry hashes and the kinds include "body". Other kinds
        // (status / header / exception) don't need this — their
        // primary signal is already actionable on its own.
        if (kinds.includes("body")) {
          const diff = diffJsonBodies(leftProbe.bodyText, rightProbe.bodyText);
          if (diff) m.bodyDiff = diff;
        }
        mismatches.push(m);
      } else matches.push(probe);
    }
  } finally {
    // Always tear down — leaking a Chromium across CI runs is a
    // multi-hundred-MB-each kind of leak.
    if (browser) await browser.close();
  }

  return {
    schemaVersion: PARITY_REPORT_SCHEMA_VERSION,
    left: opts.left,
    right: opts.right,
    pathsChecked: opts.paths.length,
    mismatches,
    matches,
    config: {
      checkBody,
      checkHeaders,
      checkExceptions,
      followRedirects,
      timeoutMs,
      ...(opts.perfDeltaMs !== undefined ? { perfDeltaMs: opts.perfDeltaMs } : {}),
      ...(opts.perfRatio !== undefined ? { perfRatio: opts.perfRatio } : {}),
    },
  };
}
