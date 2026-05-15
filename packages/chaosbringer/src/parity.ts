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
   * Single-sample wall-clock is noisy by nature, so the threshold
   * (`perfDeltaMs` and/or `perfRatio`) must be set explicitly. When
   * `perfSamples > 1` the comparison runs against the configured
   * percentile of N serial samples (`perfStats[percentile]`) instead
   * of the single first-sample `durationMs` — same threshold flags,
   * fewer false positives.
   */
  | "perf";

/**
 * Percentile of N-sample timings used for the perf comparison when
 * `perfSamples > 1`. `p95` is the SLO-standard default; `median`
 * smooths harder for noisy backends; `min` is best-case (closest to
 * a warm-cache lower bound); `p99` reserves jitter headroom for
 * cold-start outliers.
 */
export type PerfPercentile = "min" | "median" | "p95" | "p99";

/**
 * Distribution of N serial-sample timings for one side of a probe.
 * Populated by `runParity` when `perfSamples > 1`; `undefined` for
 * the default single-sample mode (in that case `durationMs` is the
 * only timing available).
 *
 * `samples` is the count of samples that actually completed — a
 * sample that errored after the first one doesn't contribute a
 * duration and is excluded. So a `perfSamples: 10` run with one
 * mid-run failure yields `samples: 9` here.
 */
export interface PerfStats {
  samples: number;
  min: number;
  median: number;
  p95: number;
  p99: number;
}

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
   * When `perfSamples > 1` this is the FIRST sample's timing —
   * `perfStats` carries the distribution across all samples.
   */
  durationMs?: number;
  /**
   * N-sample timing distribution. Set only when the run was
   * configured with `perfSamples > 1` and at least one sample beyond
   * the first completed successfully. The classifier uses
   * `perfStats[perfPercentile]` for the perf comparison when this is
   * present; otherwise it falls back to `durationMs`.
   */
  perfStats?: PerfStats;
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
    perfSamples?: number;
    perfPercentile?: PerfPercentile;
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
  /**
   * Number of serial fetch samples per side per path. Defaults to 1
   * (single-sample, the original behaviour). Set to >1 to defeat
   * wall-clock jitter — `perfStats` is populated with the distribution
   * and the perf threshold compares the configured `perfPercentile`
   * instead of `durationMs`.
   *
   * Samples run serially (single connection — concurrent samples would
   * change the timing model). The per-sample timeout is `timeoutMs`,
   * so worst-case wall-clock per probe is `perfSamples * timeoutMs`
   * per side. The first sample captures status/headers/body as
   * before; later samples contribute timing only.
   */
  perfSamples?: number;
  /**
   * Which percentile of `perfStats` to compare against `perfDeltaMs` /
   * `perfRatio` when `perfSamples > 1`. Defaults to `"p95"` — the
   * SLO-standard target. Ignored when `perfSamples <= 1` because there
   * is no distribution to take a percentile of.
   */
  perfPercentile?: PerfPercentile;
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

interface SampleOpts {
  followRedirects: boolean;
  timeoutMs: number;
  fetcher: typeof fetch;
  checkBody: boolean;
  checkHeaders: string[];
}

async function probeOneSample(url: string, opts: SampleOpts): Promise<ProbedSide> {
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
    } else {
      // Drain the body so each sample's timing reflects a comparable
      // transaction. Without this, a server that streams a large
      // response would look artificially fast (we'd return as soon as
      // headers landed). The drain is best-effort — some response
      // bodies aren't readable twice or at all in test doubles, so a
      // failure here is silently swallowed.
      try {
        await resp.arrayBuffer();
      } catch {
        // Body drain failed (test double, already-consumed stream).
        // Timing already captured pre-catch; carry on.
      }
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

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  // Nearest-rank with ceiling: matches the conventional "p95 of 10
  // samples is the 10th element" reading. Clamped to the array so the
  // worst sample is always reachable.
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx];
}

function computePerfStats(durations: number[]): PerfStats {
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    min: sorted[0],
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

async function probeSide(
  base: string,
  path: string,
  opts: SampleOpts & { perfSamples: number },
): Promise<ProbedSide> {
  const url = joinBase(base, path);
  const first = await probeOneSample(url, opts);
  // First-sample failure short-circuits: extra samples wouldn't change
  // the classification (status=null wins over any timing) and would
  // just pay N × timeoutMs in wall-clock for nothing.
  if (first.result.status === null || opts.perfSamples <= 1) {
    return first;
  }
  const durations: number[] = [];
  if (typeof first.result.durationMs === "number") {
    durations.push(first.result.durationMs);
  }
  for (let i = 1; i < opts.perfSamples; i++) {
    const next = await probeOneSample(url, opts);
    if (typeof next.result.durationMs === "number") {
      durations.push(next.result.durationMs);
    }
    // We deliberately do NOT replace `first` even if a later sample
    // produced a different status / body — the first sample is the
    // canonical record. Mixed status across samples is a bug worth
    // catching, but that's the job of a flakiness probe, not parity.
  }
  if (durations.length >= 2) {
    first.result.perfStats = computePerfStats(durations);
  }
  return first;
}

interface ClassifyOptions {
  perfDeltaMs?: number;
  perfRatio?: number;
  perfPercentile?: PerfPercentile;
}

/**
 * Pick the timing value the perf threshold should compare. When the
 * side carries `perfStats` (N-sample mode) we use the configured
 * percentile so wall-clock jitter on a single sample can't trip the
 * threshold. Otherwise the legacy single-sample `durationMs` is the
 * only thing we have.
 */
function pickPerfValue(side: SideResult, percentile: PerfPercentile): number | undefined {
  if (side.perfStats) return side.perfStats[percentile];
  return side.durationMs;
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
  // `pickPerfValue` switches to `perfStats[percentile]` when N-sample
  // mode is on, so the OR-of-thresholds runs against the chosen
  // percentile rather than a noisy single sample.
  const percentile = opts.perfPercentile ?? "p95";
  const lPerf = pickPerfValue(left, percentile);
  const rPerf = pickPerfValue(right, percentile);
  if (
    typeof lPerf === "number" &&
    typeof rPerf === "number" &&
    ((opts.perfDeltaMs && opts.perfDeltaMs > 0 && rPerf - lPerf > opts.perfDeltaMs) ||
      (opts.perfRatio &&
        opts.perfRatio > 0 &&
        lPerf > 0 &&
        rPerf > lPerf * opts.perfRatio))
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
  // perfSamples normalised to >=1; 0/negative would silently disable
  // probing entirely otherwise. Default 1 keeps single-sample as the
  // base behaviour.
  const perfSamples = Math.max(1, Math.floor(opts.perfSamples ?? 1));
  const perfPercentile: PerfPercentile = opts.perfPercentile ?? "p95";

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
      // is symmetric, so there's no reason to serialise. Inside each
      // side the N samples run serially (single-connection timing
      // model); only the left/right pairing is concurrent.
      const sideOpts = { followRedirects, timeoutMs, fetcher, checkBody, checkHeaders, perfSamples };
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
        perfPercentile,
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
      // Echo the resolved sampling config only when N-sample mode is
      // actually on, so the legacy single-sample report shape stays
      // unchanged for existing consumers.
      ...(perfSamples > 1 ? { perfSamples, perfPercentile } : {}),
    },
  };
}
