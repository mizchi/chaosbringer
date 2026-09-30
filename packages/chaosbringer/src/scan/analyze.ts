/**
 * `analyzeScan`: the triage step of `chaosbringer scan`. Pure — it reads the
 * reports the scan's crawls wrote and returns findings, so every rule is
 * unit-testable on a hand-built report without a browser.
 *
 * Two inputs:
 * - `baseline`: a crawl of the site as it is, with `perf` on. Bugs (errors,
 *   broken pages) and slow spots (vitals, main-thread blocking, layout work,
 *   heavy pages, leaks) are read off it.
 * - `chaos` (optional): the same crawl with faults injected on the site's
 *   API requests. What breaks only there — an exception, a rejection, a
 *   page that no longer loads, a step that waits out a hung request — is a
 *   resilience finding: the app has no path for that failure.
 *
 * Findings are signals, not verdicts: an unknown site has no fixed variant
 * to compare against, so the perf rules are thresholds (Web Vitals' own
 * good / poor bounds where one exists). Each perf finding names the entries
 * of the perf-patterns catalog that produce the same signal, as a starting
 * point for what the cause may be.
 */

import { reportSpans } from "../perf-summary.js";
import type { CrawlReport, PageResult, PerfSpanReport } from "../types.js";
import type { ErrorCluster } from "../clusters.js";
import { endpointLabel } from "./endpoints.js";

export type ScanSeverity = "high" | "medium" | "low";
export type ScanCategory = "bug" | "resilience" | "perf" | "a11y";

export interface ScanFinding {
  /** The rule that raised it, e.g. `js-exception`, `span-blocking`. Stable across runs. */
  rule: string;
  severity: ScanSeverity;
  category: ScanCategory;
  title: string;
  /**
   * Where it was seen, worst first: page URLs, or perfKeys for a step
   * (`<urlPattern> :: <kind>`), capped at `SCAN_WHERE_CAP`. `occurrences`
   * counts all of them.
   */
  where: string[];
  occurrences: number;
  /** The measured facts, one short line each. */
  evidence: string[];
  /** What usually causes it and where to look. */
  hint: string;
  /** perf-patterns catalog entries that show this signal (`examples/perf-patterns/src/patterns/<name>.ts`). */
  patterns?: string[];
}

export interface ScanAnalysis {
  findings: ScanFinding[];
  counts: Record<ScanSeverity, number>;
  /** Failures caused by the scan's environment, left out of `findings` (see `ENVIRONMENT_ERROR`). */
  environment: ScanEnvironmentNote[];
}

/** How many locations a finding lists. */
export const SCAN_WHERE_CAP = 5;

/**
 * Every threshold the perf rules use, in one place. `warn` raises a
 * low/medium finding, `poor` a high one. The vitals bounds are Web Vitals'
 * "good" and "poor" limits.
 */
export const SCAN_THRESHOLDS = {
  vitals: {
    LCP: { warn: 2500, poor: 4000, unit: "ms" },
    INP: { warn: 200, poor: 500, unit: "ms" },
    CLS: { warn: 0.1, poor: 0.25, unit: "" },
    FCP: { warn: 1800, poor: 3000, unit: "ms" },
    TTFB: { warn: 800, poor: 1800, unit: "ms" },
  },
  /** Long-task time inside one step (ms). */
  blockingMs: { warn: 50, poor: 200 },
  /** Slowest interaction inside one step, input → next paint (ms). */
  interactionMs: { warn: 200, poor: 500 },
  /** Forced layouts inside one step. */
  layoutCount: { warn: 30, poor: 100 },
  /** Layout time inside one step (ms); one frame is 16.7. */
  layoutMs: { warn: 16, poor: 100 },
  /** Style recalculation time inside one step (ms). */
  recalcStyleMs: { warn: 16, poor: 100 },
  /** JS execution time inside one step (ms). */
  scriptMs: { warn: 50, poor: 300 },
  /** Live DOM nodes at the end of a step. */
  domNodes: { warn: 1500, poor: 3000 },
  /** Live event listeners at the end of a step. */
  listeners: { warn: 500, poor: 2000 },
  /** JS heap growth inside one step (MB). */
  heapDeltaMB: { warn: 10, poor: 50 },
  /** Requests one action (not a page load) started. */
  actionRequests: { warn: 15, poor: 40 },
  /** How long until an action's own work finished, `max(durationMs, network.settledMs)` (ms). */
  actionEffectiveMs: { warn: 500, poor: 2000 },
  /** Requests to one endpoint (ids folded) with distinct URLs inside one step. */
  perItemRequests: { warn: 5, poor: 20 },
  /** A single response's transfer size (KB). */
  resourceKB: { warn: 500, poor: 2000 },
  /** Page loads that downloaded the same static file again (not from cache). */
  repeatDownloads: { warn: 3, poor: 10 },
  /** Waterfall depth (serial request waves) of a page load. */
  loadWaves: { warn: 4, poor: 6 },
  /** Transfer size of one page visit (KB). */
  pageKB: { warn: 1500, poor: 4000 },
  /** Third-party requests of one page visit. */
  thirdPartyRequests: { warn: 30, poor: 80 },
  /** Third-party transfer size of one page visit (KB). */
  thirdPartyKB: { warn: 500, poor: 2000 },
  /** Render-blocking stylesheets in <head> worth a finding (one or two is normal; any blocking script is flagged). */
  blockingStylesheets: 3,
  /** Dropped display frames inside one step. */
  droppedFrames: { warn: 10, poor: 30 },
  /** A single request's duration (ms). */
  slowRequestMs: { warn: 1000, poor: 3000 },
  /** Share of shipped JS the whole crawl never ran (%). */
  unusedJsPct: { warn: 50, poor: 75 },
  /**
   * A step under the scan's hang fault that took at least this share of the
   * hang's release time waited the hang out: no client-side timeout.
   */
  hangWaitShare: 0.8,
  /**
   * ...unless the same step was already that slow in the clean crawl: only
   * a step whose clean effective time is under this share of the release
   * time counts.
   */
  hangCleanShare: 0.5,
  /**
   * A step under a fault that started at least this many times the requests
   * it starts clean (and at least `stormMinExtra` more) is retrying without
   * a bound.
   */
  stormRatio: 3,
  stormMinExtra: 10,
} as const;

/** The faults a scan's chaos crawls inject, one crawl each. */
export type ScanFaultKind = "status" | "abort" | "hang";
export const SCAN_FAULT_KINDS: readonly ScanFaultKind[] = ["status", "abort", "hang"];

/** Fault names the scan's chaos crawls use (they tag spans and fault stats). */
export const SCAN_FAULT_NAMES: Record<ScanFaultKind, string> = {
  status: "scan:api-500",
  abort: "scan:api-abort",
  hang: "scan:api-hang",
};

/** How findings say which fault it was. */
export const SCAN_FAULT_LABELS: Record<ScanFaultKind, string> = {
  status: "HTTP 500",
  abort: "network failure",
  hang: "no response",
};

/** One chaos crawl: every request to the site's API endpoints answered with `fault`. */
export interface ScanChaosRun {
  fault: ScanFaultKind;
  report: CrawlReport;
}

export interface AnalyzeScanOptions {
  /** `releaseAfterMs` of the hang crawl's fault; enables the no-timeout rule. */
  hangReleaseMs?: number;
  /**
   * Regex source matching the endpoints the chaos crawls failed
   * (`endpointsPattern`). The retry-storm and no-timeout rules count only
   * requests to them; without it they count every request.
   */
  endpointPattern?: string;
}

/**
 * Request failures the scan itself causes, not the site: a proxy on the
 * scanning machine that refused the host, the crawler's own external-
 * navigation guard (which also stops cross-origin iframe documents), and
 * requests cancelled when the crawl navigated on (`ERR_ABORTED`: beacons and
 * prefetches cut off mid-flight; an app's own AbortController shows the same
 * way, and is deliberate). Reported once as a note, never as a finding.
 */
export const ENVIRONMENT_ERROR = /net::ERR_(TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED|PROXY_AUTH_UNSUPPORTED|BLOCKED_BY_CLIENT|ABORTED)\b/;

/** Why each `ENVIRONMENT_ERROR` code is not the site's, for the report. */
export const ENVIRONMENT_REASONS: Record<string, string> = {
  "net::ERR_TUNNEL_CONNECTION_FAILED": "a proxy on the scanning machine refused the host",
  "net::ERR_PROXY_CONNECTION_FAILED": "the scanning machine's proxy could not be reached",
  "net::ERR_PROXY_AUTH_UNSUPPORTED": "the scanning machine's proxy wants authentication",
  "net::ERR_BLOCKED_BY_CLIENT": "the crawler's external-navigation guard (it also stops cross-origin iframe documents)",
  "net::ERR_ABORTED": "cancelled in flight, mostly by the crawl navigating on",
};

export interface ScanEnvironmentNote {
  /** The `net::ERR_*` code. */
  code: string;
  /** Errors carrying it (console echoes and request failures both count). */
  count: number;
  /** Hosts whose requests failed with it, up to `SCAN_WHERE_CAP`. */
  hosts: string[];
}

/**
 * Which perf-patterns catalog entries produce each rule's signal: a pattern
 * is listed under a rule when the metric its test asserts on (or a direct
 * consequence of it: long tasks from heavy script, a slow interaction from
 * a heavy click handler) is the one the rule reads. `pnpm scan-check` in
 * examples/perf-patterns measures how well these hold up on the catalog.
 */
export const RULE_PATTERNS: Record<string, readonly string[]> = {
  "vital-lcp": ["late-discovered-lcp", "lcp-lazy-hero", "font-block-foit", "late-font-discovery", "render-blocking-script", "oversized-image"],
  "vital-cls": ["cls-image-no-dimensions", "cls-late-content", "font-swap-cls"],
  "vital-inp": ["long-task-click", "no-yield-before-work", "sync-xhr-click", "canvas-to-dataurl-sync", "sync-storage-on-input"],
  "vital-fcp": ["css-import-chain", "render-blocking-script", "print-stylesheet-blocking", "no-early-flush", "module-import-chain", "unbundled-modules", "revalidate-every-load"],
  "vital-ttfb": ["redirect-chain", "no-early-flush"],
  "span-blocking": [
    "long-task-click",
    "canvas-to-dataurl-sync",
    "regex-backtracking",
    "sync-xhr-click",
    "worker-offload",
    "json-deep-clone-per-click",
    "quadratic-dedupe",
    "eager-heavy-bundle",
    "console-log-heavy",
    "innerhtml-append-loop",
    "intl-formatter-per-row",
    "broad-mutation-observer",
    "full-rerender-list",
    "structured-clone-transfer",
  ],
  "span-interaction": [
    "long-task-click",
    "no-yield-before-work",
    "sync-xhr-click",
    "sync-storage-on-input",
    "canvas-to-dataurl-sync",
    "innerhtml-append-loop",
    "intl-formatter-per-row",
    "broad-mutation-observer",
  ],
  "span-script": [
    "broad-mutation-observer",
    "console-log-heavy",
    "eager-heavy-bundle",
    "full-rerender-list",
    "idle-raf-loop",
    "inline-state-bloat",
    "innerhtml-append-loop",
    "intl-formatter-per-row",
    "json-deep-clone-per-click",
    "quadratic-dedupe",
    "render-hidden-tabs",
    "structured-clone-transfer",
    "sync-storage-on-input",
    "sync-storage-read-on-load",
    "worker-offload",
  ],
  "span-layout": ["layout-thrash", "layout-animation", "unthrottled-scroll"],
  "span-layout-time": ["full-rerender-list", "offscreen-render-cost", "layout-thrash", "huge-dom"],
  "span-style": ["expensive-selectors", "runtime-style-injection", "huge-dom"],
  "dom-size": ["huge-dom", "inline-svg-icons", "render-hidden-tabs", "detached-dom-leak"],
  "many-listeners": ["no-event-delegation", "listener-leak"],
  "heap-growth": ["unbounded-memo-cache", "detached-dom-leak"],
  "memory-leak": ["detached-dom-leak", "listener-leak", "unbounded-memo-cache"],
  "chatty-action": ["analytics-per-event", "input-no-debounce", "polling-spam"],
  "slow-action": ["idb-transaction-per-item", "sync-xhr-click", "over-fetching-api"],
  "request-waterfall": ["request-waterfall", "css-import-chain", "module-import-chain", "waterfall-amplifies-delay", "late-discovered-lcp", "late-font-discovery", "unbundled-modules"],
  "dropped-frames": ["layout-animation", "unthrottled-scroll", "long-task-click"],
  "slow-request": ["no-cache-headers", "over-fetching-api", "cors-preflight-per-request"],
  "heavy-resource": ["font-no-subset", "oversized-image", "uncompressed-bundle", "over-fetching-api", "inline-state-bloat", "eager-heavy-bundle"],
  "duplicate-request": ["duplicate-fetch", "retry-storm"],
  "per-item-requests": ["n-plus-one"],
  "repeat-download": ["no-cache-headers", "cache-busting-query", "revalidate-every-load"],
  "page-weight": [
    "base64-inlined-assets",
    "cache-busting-query",
    "no-cache-headers",
    "inline-state-bloat",
    "unused-preload",
    "oversized-image",
    "font-no-subset",
    "over-fetching-api",
    "eager-iframes",
    "third-party-bloat",
  ],
  "third-party-heavy": ["third-party-bloat", "eager-iframes", "analytics-per-event", "cors-preflight-per-request"],
  "render-blocking": ["render-blocking-script", "css-import-chain", "print-stylesheet-blocking"],
  "oversized-image": ["oversized-image", "lcp-lazy-hero"],
  "uncompressed-text": ["uncompressed-bundle"],
  "never-idle": ["polling-spam", "idle-raf-loop", "retry-storm"],
  "unused-js": ["eager-heavy-bundle", "unbundled-modules", "unused-preload"],
  "no-request-timeout": ["hang-no-timeout"],
  "fault-request-storm": ["retry-storm"],
};

type Located = { where: string; value: number; line: string };

const SEVERITY_ORDER: Record<ScanSeverity, number> = { high: 0, medium: 1, low: 2 };
const CATEGORY_ORDER: Record<ScanCategory, number> = { bug: 0, resilience: 1, a11y: 2, perf: 3 };

export function analyzeScan(
  baseline: CrawlReport,
  chaos: readonly ScanChaosRun[] = [],
  options: AnalyzeScanOptions = {},
): ScanAnalysis {
  const environment = environmentNotes([baseline, ...chaos.map((r) => r.report)]);
  baseline = withoutEnvironmentErrors(baseline);
  chaos = chaos.map((r) => ({ ...r, report: withoutEnvironmentErrors(r.report) }));
  const findings: ScanFinding[] = [
    ...pageFailures(baseline),
    ...errorFindings(baseline),
    ...perfFindings(baseline),
    ...resilienceFindings(baseline, chaos, options),
  ].map((f) => {
    const patterns = RULE_PATTERNS[f.rule];
    return patterns ? { ...f, patterns: [...patterns] } : f;
  });
  findings.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] ||
      b.occurrences - a.occurrences ||
      a.rule.localeCompare(b.rule),
  );
  const counts: Record<ScanSeverity, number> = { high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;
  return { findings, counts, environment };
}

function withoutEnvironmentErrors(report: CrawlReport): CrawlReport {
  const clusters = report.errorClusters ?? [];
  if (!clusters.some((c) => ENVIRONMENT_ERROR.test(c.sample.message))) return report;
  return { ...report, errorClusters: clusters.filter((c) => !ENVIRONMENT_ERROR.test(c.sample.message)) };
}

function environmentNotes(reports: readonly CrawlReport[]): ScanEnvironmentNote[] {
  const byCode = new Map<string, { count: number; hosts: Set<string> }>();
  // The clean crawl alone: the chaos crawls repeat the same pages, and
  // counting them too would multiply one blocked host by four.
  const report = reports[0];
  for (const c of report?.errorClusters ?? []) {
    const code = ENVIRONMENT_ERROR.exec(c.sample.message)?.[1];
    if (!code) continue;
    const entry = byCode.get(code) ?? { count: 0, hosts: new Set<string>() };
    entry.count += c.count;
    // A request failure reads "<url> - net::ERR_…"; a console echo names no URL.
    const url = /^(https?:\/\/\S+) - /.exec(c.sample.message)?.[1];
    if (url) {
      try {
        entry.hosts.add(new URL(url).host);
      } catch {
        // not a URL after all
      }
    }
    byCode.set(code, entry);
  }
  return [...byCode.entries()]
    .map(([code, e]) => ({ code: `net::ERR_${code}`, count: e.count, hosts: [...e.hosts].slice(0, SCAN_WHERE_CAP) }))
    .sort((a, b) => b.count - a.count);
}

// ---------------------------------------------------------------- bugs

function pageFailures(report: CrawlReport): ScanFinding[] {
  const out: ScanFinding[] = [];
  const failed = report.pages.filter((p) => p.status === "error" || p.status === "timeout");
  if (failed.length > 0) {
    out.push({
      rule: "page-load-failed",
      severity: "high",
      category: "bug",
      title: "Pages that did not load",
      where: capWhere(failed.map((p) => p.url)),
      occurrences: failed.length,
      evidence: failed.slice(0, SCAN_WHERE_CAP).map((p) => `${p.url}: ${p.status}${linkedFrom(p)}`),
      hint: "The navigation failed or timed out. A timeout on a page that renders fine in a browser is usually a request that never settles (a long poll, a stream, an analytics beacon) — check the page's network tab.",
    });
  }
  const server = report.pages.filter((p) => (p.statusCode ?? 0) >= 500);
  if (server.length > 0) {
    out.push({
      rule: "http-5xx",
      severity: "high",
      category: "bug",
      title: "Pages answered with a server error",
      where: capWhere(server.map((p) => p.url)),
      occurrences: server.length,
      evidence: server.slice(0, SCAN_WHERE_CAP).map((p) => `${p.url}: HTTP ${p.statusCode}${linkedFrom(p)}`),
      hint: "The server failed on these URLs. They were reached by following the site's own links, so a user can reach them too.",
    });
  }
  const broken = report.pages.filter((p) => {
    const s = p.statusCode ?? 0;
    return s >= 400 && s < 500;
  });
  if (broken.length > 0) {
    out.push({
      rule: "broken-link",
      severity: "medium",
      category: "bug",
      title: "Links to pages that do not exist",
      where: capWhere(broken.map((p) => p.url)),
      occurrences: broken.length,
      evidence: broken.slice(0, SCAN_WHERE_CAP).map((p) => `${p.url}: HTTP ${p.statusCode}${linkedFrom(p)}`),
      hint: "Each URL was found in a link on the site. Fix or remove the link on the page it was linked from.",
    });
  }
  return out;
}

function linkedFrom(p: PageResult): string {
  return p.sourceUrl ? ` (linked from ${p.sourceUrl})` : "";
}

const ERROR_RULES: Record<
  ErrorCluster["type"],
  { rule: string; severity: ScanSeverity; category: ScanCategory; title: string; hint: string } | null
> = {
  exception: {
    rule: "js-exception",
    severity: "high",
    category: "bug",
    title: "Uncaught exception",
    hint: "An error reached window.onerror: the code that threw stopped, and whatever it was doing (a render, a handler) did not finish.",
  },
  "unhandled-rejection": {
    rule: "unhandled-rejection",
    severity: "high",
    category: "bug",
    title: "Unhandled promise rejection",
    hint: "A promise failed and nothing caught it: the UI waiting on it usually stays in its loading state or keeps stale data.",
  },
  crash: {
    rule: "page-crash",
    severity: "high",
    category: "bug",
    title: "The page crashed",
    hint: "The renderer process died (out of memory, or a browser bug the page triggers).",
  },
  console: {
    rule: "console-error",
    severity: "medium",
    category: "bug",
    title: "console.error",
    hint: "Logged with console.error, or a resource the browser failed to load (\"Failed to load resource\" is a 4xx/5xx subresource).",
  },
  network: {
    rule: "request-failed",
    severity: "low",
    category: "bug",
    title: "Request failed",
    hint: "A request failed at the transport level: DNS, connection refused, TLS, or a CORS or mixed-content block. (Cancelled and proxy-refused requests are not counted; see the report's notes.)",
  },
  "invariant-violation": {
    rule: "invariant-violation",
    severity: "medium",
    category: "bug",
    title: "Invariant violated",
    hint: "A check the crawl ran on every page failed.",
  },
};

function errorFindings(report: CrawlReport): ScanFinding[] {
  const out: ScanFinding[] = [];
  // Documents that answered 4xx/5xx: the browser logs each as "Failed to load
  // resource", which `pageFailures` already reports as the page's own finding.
  const failedDocs = new Set(report.pages.filter((p) => (p.statusCode ?? 0) >= 400).map((p) => p.url));
  for (const c of report.errorClusters ?? []) {
    const r = ERROR_RULES[c.type];
    if (!r) continue;
    if (c.type === "console" && /Failed to load resource/i.test(c.sample.message) && c.urls.length > 0 && c.urls.every((u) => failedDocs.has(u))) {
      continue;
    }
    const isAxe = c.type === "invariant-violation" && (c.invariantNames ?? []).some((n) => n.startsWith("a11y"));
    out.push({
      rule: isAxe ? "a11y-violation" : r.rule,
      severity: r.severity,
      category: isAxe ? "a11y" : r.category,
      title: `${isAxe ? "Accessibility violation" : r.title}: ${truncate(c.sample.message, 120)}`,
      where: capWhere(c.urls),
      occurrences: c.count,
      evidence: [
        `${c.count}× on ${c.urls.length} page${c.urls.length === 1 ? "" : "s"}`,
        ...(c.sample.stack ? [truncate(firstStackFrame(c.sample.stack), 160)] : []),
      ],
      hint: r.hint,
    });
  }
  return out;
}

// ---------------------------------------------------------- resilience

/** Console noise a fault itself produces: the browser logging the failed request. */
const FAULT_ECHO = /Failed to load resource|net::ERR_|status of 5\d\d/i;

function resilienceFindings(
  baseline: CrawlReport,
  runs: readonly ScanChaosRun[],
  options: AnalyzeScanOptions,
): ScanFinding[] {
  const out: ScanFinding[] = [];
  const known = new Set((baseline.errorClusters ?? []).map((c) => c.key));

  // Errors that only a fault produced, merged over the runs by cluster.
  const fresh = new Map<string, { c: ErrorCluster; count: number; urls: Set<string>; faults: ScanFaultKind[] }>();
  for (const { fault, report } of runs) {
    for (const c of report.errorClusters ?? []) {
      if (known.has(c.key)) continue;
      if (c.type === "network" || c.type === "invariant-violation") continue;
      if (c.type === "console" && FAULT_ECHO.test(c.sample.message)) continue;
      const entry = fresh.get(c.key) ?? { c, count: 0, urls: new Set<string>(), faults: [] };
      entry.count += c.count;
      for (const u of c.urls) entry.urls.add(u);
      entry.faults.push(fault);
      fresh.set(c.key, entry);
    }
  }
  for (const { c, count, urls, faults } of fresh.values()) {
    const severe = c.type === "exception" || c.type === "unhandled-rejection" || c.type === "crash";
    out.push({
      rule: "fault-new-error",
      severity: severe ? "high" : "medium",
      category: "resilience",
      title: `Only when an API request fails: ${ERROR_RULES[c.type]?.title ?? c.type}: ${truncate(c.sample.message, 100)}`,
      where: capWhere([...urls]),
      occurrences: count,
      evidence: [
        `${count}× under ${faults.map((f) => SCAN_FAULT_LABELS[f]).join(", ")}; never in the clean crawl`,
        ...(c.sample.stack ? [truncate(firstStackFrame(c.sample.stack), 160)] : []),
      ],
      hint: "The code assumes the request succeeds. Check response.ok / catch the rejection, and give the UI an error state (message + retry) instead of throwing.",
    });
  }

  // Pages that loaded clean and not under a fault.
  const cleanOk = new Set(baseline.pages.filter((p) => p.status === "success").map((p) => p.url));
  const broke = new Map<string, { status: string; faults: ScanFaultKind[] }>();
  for (const { fault, report } of runs) {
    for (const p of report.pages) {
      if (!cleanOk.has(p.url) || (p.status !== "error" && p.status !== "timeout")) continue;
      const entry = broke.get(p.url) ?? { status: p.status, faults: [] };
      entry.faults.push(fault);
      broke.set(p.url, entry);
    }
  }
  if (broke.size > 0) {
    const urls = [...broke.keys()];
    out.push({
      rule: "fault-page-broken",
      severity: "high",
      category: "resilience",
      title: "Pages that stop loading when an API request fails",
      where: capWhere(urls),
      occurrences: urls.length,
      evidence: urls
        .slice(0, SCAN_WHERE_CAP)
        .map((u) => `${u}: ${broke.get(u)!.status} under ${broke.get(u)!.faults.map((f) => SCAN_FAULT_LABELS[f]).join(", ")} (loaded in the clean crawl)`),
      hint: "The page's load depends on the request finishing. Render the shell first and fill the data in when it arrives (or fails).",
    });
  }

  // Steps that fire far more requests when their API fails: unbounded retries.
  // Only requests to the failed endpoints count: a retry goes back to the
  // endpoint that failed, whereas a fallback (a router that reloads the whole
  // page when its data request fails) fetches the page's other resources.
  const endpoint = options.endpointPattern ? new RegExp(options.endpointPattern) : null;
  const apiRequests = (s: PerfSpanReport) =>
    endpoint ? s.network.requests.filter((q) => endpoint.test(q.url)).length : s.network.requestCount;
  const cleanRequests = new Map<string, number>();
  for (const s of reportSpans(baseline)) cleanRequests.set(s.key, Math.max(cleanRequests.get(s.key) ?? 0, apiRequests(s)));
  const storms = new Map<string, Located & { fault: ScanFaultKind }>();
  for (const { fault, report } of runs) {
    for (const s of reportSpans(report)) {
      const clean = cleanRequests.get(s.key);
      if (clean === undefined) continue;
      const n = apiRequests(s);
      if (n < clean * SCAN_THRESHOLDS.stormRatio || n < clean + SCAN_THRESHOLDS.stormMinExtra) continue;
      const prev = storms.get(s.key);
      if (prev && prev.value >= n) continue;
      const what = endpoint ? "requests to the failing endpoints" : "requests";
      storms.set(s.key, { where: s.key, value: n, fault, line: `${s.key}: ${n} ${what} under ${SCAN_FAULT_LABELS[fault]} (clean ${clean})` });
    }
  }
  if (storms.size > 0) {
    out.push(
      located([...storms.values()], {
        rule: "fault-request-storm",
        severity: "high",
        category: "resilience",
        title: "Steps that multiply their requests when an API call fails (retry storm)",
        hint: "A failure is retried at once and without a bound, from every caller. Retry a bounded number of times, with exponential backoff and jitter, and stop on a 4xx.",
      }),
    );
  }

  // Steps that waited for a request that never answered.
  const release = options.hangReleaseMs;
  const hang = runs.find((r) => r.fault === "hang");
  if (hang && release !== undefined && release > 0) {
    const cleanWorst = new Map<string, { effectiveMs: number; capped: boolean }>();
    for (const s of reportSpans(baseline)) {
      const prev = cleanWorst.get(s.key);
      const eff = effectiveMs(s);
      cleanWorst.set(s.key, { effectiveMs: Math.max(prev?.effectiveMs ?? 0, eff), capped: (prev?.capped ?? false) || s.capped });
    }
    // A load whose hung requests all started after the page had painted its
    // largest content was not waiting on them: prefetches and beacons a page
    // fires once it is up. The crawl's settle waits for them, the user does not.
    const lcpOfLoad = new Map<PerfSpanReport, number>();
    for (const p of hang.report.pages) {
      const lcp = p.perfPage?.vitals.LCP?.value;
      if (p.perf && lcp !== undefined) lcpOfLoad.set(p.perf, lcp);
    }
    const background = (s: PerfSpanReport): boolean => {
      const lcp = lcpOfLoad.get(s);
      if (lcp === undefined) return false;
      const hung = s.network.requests.filter(
        (q) => (!endpoint || endpoint.test(q.url)) && (q.unfinished === true || q.durationMs >= release * SCAN_THRESHOLDS.hangWaitShare),
      );
      return hung.length > 0 && hung.every((q) => q.startOffsetMs > lcp);
    };
    const waited = new Map<string, Located>();
    for (const s of reportSpans(hang.report)) {
      if (!(s.faults ?? []).includes(SCAN_FAULT_NAMES.hang)) continue;
      if (background(s)) continue;
      const clean = cleanWorst.get(s.key);
      if (!clean || clean.capped || clean.effectiveMs >= release * SCAN_THRESHOLDS.hangCleanShare) continue;
      const eff = effectiveMs(s);
      // An action's settle gives up at its cap while the request is still
      // open; the load's waits for it (up to the navigation timeout).
      const stillWaiting = s.capped && s.network.settledUnfinished === true;
      if (eff < release * SCAN_THRESHOLDS.hangWaitShare && !stillWaiting) continue;
      const prev = waited.get(s.key);
      if (prev && prev.value >= eff) continue;
      waited.set(s.key, {
        where: s.key,
        value: eff,
        line: stillWaiting
          ? `${s.key}: still waiting on the request when the step's settle gave up (${fmt(eff)}ms; clean ${fmt(clean.effectiveMs)}ms)`
          : `${s.key}: ${fmt(eff)}ms with a request that never answered (clean ${fmt(clean.effectiveMs)}ms)`,
      });
    }
    if (waited.size > 0) {
      out.push(
        located([...waited.values()], {
          rule: "no-request-timeout",
          severity: "medium",
          category: "resilience",
          title: "Steps that wait forever on a request that never answers (no client timeout)",
          hint: `A request that never answered was failed by the scan only after ${release}ms, and the step was still waiting. Put a deadline on the request (AbortSignal.timeout) and show a fallback with a retry.`,
        }),
      );
    }
  }
  return out;
}

/** How long until a step's own work finished: `max(durationMs, network.settledMs)`. */
function effectiveMs(s: PerfSpanReport): number {
  return Math.max(s.durationMs, s.network.settledMs ?? 0);
}

// ---------------------------------------------------------------- perf

const VITAL_HINTS: Record<string, string> = {
  LCP: "The largest element painted late. Check that it is discoverable from the HTML (no lazy-loading, no CSS background, preloaded), that nothing render-blocking sits in front of it, and that the image is sized for its slot.",
  CLS: "Content moved after it was painted. Reserve space for images (width/height), late-inserted content, and web fonts (a metric-matched fallback).",
  INP: "An interaction took long to paint its result. Break up the handler's work, yield before heavy work, and keep layout reads out of the handler.",
  FCP: "Nothing painted for a long time. Look for render-blocking scripts and stylesheets in <head> and @import chains.",
  TTFB: "The server (or a redirect chain) took long to send the first byte of the document.",
};

function perfFindings(report: CrawlReport): ScanFinding[] {
  const out: ScanFinding[] = [];
  const pages = report.pages.filter((p) => p.perfPage);

  // Web Vitals, per document.
  for (const [name, t] of Object.entries(SCAN_THRESHOLDS.vitals)) {
    const hits: Located[] = [];
    for (const p of pages) {
      for (const doc of documentsOf(p)) {
        const v = doc.vitals[name]?.value;
        if (v === undefined || v < t.warn) continue;
        hits.push({ where: doc.url, value: v, line: `${doc.url}: ${name} ${fmt(v)}${t.unit}` });
      }
    }
    if (hits.length === 0) continue;
    const worst = Math.max(...hits.map((h) => h.value));
    out.push(
      located(hits, {
        rule: `vital-${name.toLowerCase()}`,
        severity: worst >= t.poor ? "high" : "low",
        category: "perf",
        title: `${name} over ${t.warn}${t.unit}${worst >= t.poor ? ` (poor: ≥ ${t.poor}${t.unit})` : ""}`,
        hint: VITAL_HINTS[name] ?? "",
      }),
    );
  }

  // Page-level resources.
  const heavy: Located[] = [];
  const thirdParty: Located[] = [];
  const blocking: Located[] = [];
  const oversized: Located[] = [];
  const uncompressed: Located[] = [];
  for (const p of pages) {
    const s = p.perfPage!;
    if (s.network.totalEncodedKB >= SCAN_THRESHOLDS.pageKB.warn) {
      heavy.push({ where: p.url, value: s.network.totalEncodedKB, line: `${p.url}: ${fmt(s.network.totalEncodedKB)} KB over ${s.network.totalRequests} requests` });
    }
    const tp = s.network.thirdParty;
    if (tp && (tp.requestCount >= SCAN_THRESHOLDS.thirdPartyRequests.warn || tp.encodedKB >= SCAN_THRESHOLDS.thirdPartyKB.warn)) {
      const t = SCAN_THRESHOLDS;
      // Graded on whichever bound it is further past, as a share of that bound.
      const value = Math.max(tp.requestCount / t.thirdPartyRequests.poor, tp.encodedKB / t.thirdPartyKB.poor);
      thirdParty.push({ where: p.url, value, line: `${p.url}: ${tp.requestCount} third-party requests, ${fmt(tp.encodedKB)} KB` });
    }
    const rb = s.renderBlocking;
    if (rb && (rb.scripts > 0 || rb.stylesheets >= SCAN_THRESHOLDS.blockingStylesheets)) {
      blocking.push({
        where: p.url,
        value: rb.scripts * 2 + rb.stylesheets,
        line: `${p.url}: ${rb.scripts} blocking script${rb.scripts === 1 ? "" : "s"}, ${rb.stylesheets} stylesheet${rb.stylesheets === 1 ? "" : "s"} (${rb.urls.join(", ")})`,
      });
    }
    if (s.media && s.media.oversizedCount > 0) {
      oversized.push({
        where: p.url,
        value: s.media.oversizedCount,
        line: `${p.url}: ${s.media.oversizedCount} image(s), e.g. ${s.media.oversized.map((m) => `${m.url} ${fmt(m.overFetch)}× its slot, ${fmt(m.kb)} KB`).join("; ")}`,
      });
    }
    if (s.media && s.media.uncompressedCount > 0) {
      uncompressed.push({
        where: p.url,
        value: s.media.uncompressedCount,
        line: `${p.url}: ${s.media.uncompressedCount} resource(s), e.g. ${s.media.uncompressed.map((m) => `${m.url} ${fmt(m.kb)} KB`).join("; ")}`,
      });
    }
  }
  if (heavy.length > 0) {
    out.push(
      located(heavy, {
        rule: "page-weight",
        severity: severityOf(heavy, SCAN_THRESHOLDS.pageKB, "medium"),
        category: "perf",
        title: `Page visits transferring over ${SCAN_THRESHOLDS.pageKB.warn} KB`,
        hint: "Check what dominates the bytes (images, fonts, bundles, inlined state) in the page's network panel.",
      }),
    );
  }
  if (thirdParty.length > 0) {
    out.push(
      located(thirdParty, {
        rule: "third-party-heavy",
        severity: severityOf(thirdParty, { poor: 1 }, "medium"),
        category: "perf",
        title: `Page visits with over ${SCAN_THRESHOLDS.thirdPartyRequests.warn} third-party requests or ${SCAN_THRESHOLDS.thirdPartyKB.warn} KB`,
        hint: "Tags, embeds and widgets compete with the page's own resources. Defer what the first view does not need, lazy-load embeds, and batch analytics.",
      }),
    );
  }
  if (blocking.length > 0) {
    out.push(
      located(blocking, {
        rule: "render-blocking",
        severity: "low",
        category: "perf",
        title: "Render-blocking scripts or stylesheets in <head>",
        hint: "A classic <script src> without async/defer, or a stylesheet, holds the first paint until it downloads. Defer scripts; inline the critical CSS.",
      }),
    );
  }
  if (oversized.length > 0) {
    out.push(
      located(oversized, {
        rule: "oversized-image",
        severity: "medium",
        category: "perf",
        title: "Images far larger than the box they are shown in",
        hint: "At least 4× the pixels the slot displays. Serve sized variants (srcset + sizes) or resize at build time.",
      }),
    );
  }
  if (uncompressed.length > 0) {
    out.push(
      located(uncompressed, {
        rule: "uncompressed-text",
        severity: "medium",
        category: "perf",
        title: "Text resources served without compression",
        hint: "Enable gzip / brotli for text types (JS, CSS, JSON, HTML, SVG) on the server or CDN.",
      }),
    );
  }

  // Per step.
  // Actions after which the page's URL was different: route changes the
  // History API made count as moving too, though they create no document.
  const moved = new Set(report.actions.filter((a) => a.urlChanged && a.perf).map((a) => a.perf!));
  out.push(...spanFindings(reportSpans(report), moved));

  // Pages that never went quiet.
  const restless: Located[] = report.pages
    .filter((p) => (p.settleCapped ?? 0) > 0)
    .map((p) => ({ where: p.url, value: p.settleCapped!, line: `${p.url}: ${p.settleCapped} step(s) hit the settle cap` }));
  if (restless.length > 0) {
    out.push(
      located(restless, {
        rule: "never-idle",
        severity: "low",
        category: "perf",
        title: "Pages that never go quiet",
        hint: "Requests or long tasks kept arriving until the settle cap: polling, a rAF loop, retry loops, or a stream. Each costs battery and CPU in the background.",
      }),
    );
  }

  // Memory that climbs across repeats of one step.
  const leaks = (report.perf?.trends ?? []).filter((t) => t.leak);
  if (leaks.length > 0) {
    out.push(
      located(
        leaks.map((t) => ({
          where: t.name,
          value: t.perStep,
          line: `${t.name}: ${t.metric} ${t.values.map(fmt).join(" → ")} over ${t.count} repeats (+${fmt(t.perStep)} per step)`,
        })),
        {
          rule: "memory-leak",
          severity: "high",
          category: "perf",
          title: "Memory that climbs every time a step repeats",
          hint: "Something is kept per repeat: removed DOM held in a cache or closure, listeners added and never removed, or an unbounded memo.",
        },
      ),
    );
  }

  // Shipped code the crawl never ran.
  const js = report.perf?.coverage?.js;
  if (js?.usedPct !== undefined && 100 - js.usedPct >= SCAN_THRESHOLDS.unusedJsPct.warn && js.totalBytes > 100 * 1024) {
    const unused = 100 - js.usedPct;
    out.push({
      rule: "unused-js",
      severity: unused >= SCAN_THRESHOLDS.unusedJsPct.poor ? "medium" : "low",
      category: "perf",
      title: `${fmt(unused)}% of the shipped JS never ran during the crawl`,
      where: capWhere(js.lowUsage.map((f) => f.url)),
      occurrences: js.lowUsage.length,
      evidence: [
        `${fmt(js.totalBytes / 1024)} KB of JS, ${fmt(js.usedBytes / 1024)} KB executed`,
        ...js.lowUsage.slice(0, SCAN_WHERE_CAP).map((f) => `${f.url}: ${fmt(f.usedPct)}% used of ${fmt(f.totalBytes / 1024)} KB`),
      ],
      hint: "Split code the first view does not need behind import() (routes, dialogs, editors) and drop unused dependencies.",
    });
  }
  return out;
}

interface SpanRule {
  rule: string;
  title: string;
  hint: string;
  thresholds: { warn: number; poor: number };
  /** Severity when only `warn` is crossed (`poor` is always high). */
  warnSeverity: ScanSeverity;
  value: (s: PerfSpanReport, ctx: SpanContext) => number | undefined;
  line: (s: PerfSpanReport, v: number) => string;
}

interface SpanContext {
  /** The step took the user to another view (see `navigated`). */
  navigated: (s: PerfSpanReport) => boolean;
}

const SPAN_RULES: SpanRule[] = [
  {
    rule: "span-blocking",
    title: "Steps that block the main thread",
    hint: "Long tasks inside the step: the page could not respond to input while they ran. Look at what the handler or the load runs (big bundles evaluated eagerly, loops over large data, sync work) and split it, defer it, or move it to a worker.",
    thresholds: SCAN_THRESHOLDS.blockingMs,
    warnSeverity: "medium",
    value: (s) => s.cpu.blockingMs,
    line: (s, v) => `${s.key}: ${fmt(v)}ms blocking over ${s.cpu.longTaskCount} long task(s), longest ${fmt(s.cpu.maxLongTaskMs)}ms`,
  },
  {
    rule: "span-interaction",
    title: "Slow interactions (input → next paint)",
    hint: "The click or keypress took long to show its result. The breakdown says where: input delay (main thread busy before), processing (the handler), presentation (rendering after).",
    thresholds: SCAN_THRESHOLDS.interactionMs,
    warnSeverity: "medium",
    value: (s) => s.interaction?.maxDurationMs,
    line: (s, v) =>
      `${s.key}: ${fmt(v)}ms ${s.interaction!.type} (delay ${fmt(s.interaction!.inputDelayMs)} / processing ${fmt(s.interaction!.processingMs)} / presentation ${fmt(s.interaction!.presentationMs)})`,
  },
  {
    rule: "span-script",
    title: "Steps that run a lot of JavaScript",
    hint: "JS execution time inside the step. Common causes: work done per item that could be done once, rescanning the DOM, synchronous storage or cloning, or doing all the work before the first paint.",
    thresholds: SCAN_THRESHOLDS.scriptMs,
    warnSeverity: "low",
    value: (s) => s.render.scriptMs,
    line: (s, v) => `${s.key}: ${fmt(v)}ms of script`,
  },
  {
    rule: "span-layout",
    title: "Steps that force many layouts",
    hint: "Many layouts in one step is layout thrashing: code that alternates DOM writes with reads of layout (offsetHeight, getBoundingClientRect), or an animation of a layout property. Batch the reads before the writes; animate transform.",
    thresholds: SCAN_THRESHOLDS.layoutCount,
    warnSeverity: "medium",
    value: (s) => s.render.layoutCount,
    line: (s, v) => `${s.key}: ${fmt(v)} layouts, ${fmt(s.render.layoutMs)}ms`,
  },
  {
    rule: "span-layout-time",
    title: "Steps that spend long in layout",
    hint: "Layout time grows with how much of the page is laid out again: re-rendering a whole list for one change, or laying out content nobody sees yet. Update only what changed; skip offscreen work (content-visibility: auto).",
    thresholds: SCAN_THRESHOLDS.layoutMs,
    warnSeverity: "low",
    value: (s) => s.render.layoutMs,
    line: (s, v) => `${s.key}: ${fmt(v)}ms of layout over ${s.render.layoutCount} layout(s)`,
  },
  {
    rule: "span-style",
    title: "Steps with expensive style recalculation",
    hint: "Style recalc cost grows with DOM size × selectors that have to be checked. Look for a class toggled high in the tree (on <body>) with broad or :has() rules, and runtime-injected styles.",
    thresholds: SCAN_THRESHOLDS.recalcStyleMs,
    warnSeverity: "low",
    value: (s) => s.render.recalcStyleMs,
    line: (s, v) => `${s.key}: ${fmt(v)}ms recalc style over ${s.render.recalcStyleCount} recalc(s)`,
  },
  {
    rule: "dom-size",
    title: "Large DOM",
    hint: "Every node costs memory, style and layout time. Paginate or virtualise long lists, and render hidden tabs and dialogs when they open.",
    thresholds: SCAN_THRESHOLDS.domNodes,
    warnSeverity: "low",
    value: (s) => s.memory.domNodes,
    line: (s, v) => `${s.key}: ${fmt(v)} DOM nodes`,
  },
  {
    rule: "many-listeners",
    title: "Many event listeners",
    hint: "One listener per row or per item. Delegate: one listener on the container that reads event.target.closest(...).",
    thresholds: SCAN_THRESHOLDS.listeners,
    warnSeverity: "low",
    value: (s) => s.memory.jsEventListeners,
    line: (s, v) => `${s.key}: ${fmt(v)} event listeners`,
  },
  {
    rule: "heap-growth",
    title: "Steps that grow the JS heap",
    hint: "The step left that much more JS memory in use. If it keeps growing across repeats, something is retained: a cache with no bound, closures over large data, or removed DOM held in JS.",
    thresholds: SCAN_THRESHOLDS.heapDeltaMB,
    warnSeverity: "medium",
    // Not a step that moved to another view: that is the new view's heap.
    value: (s, ctx) => (ctx.navigated(s) ? undefined : s.memory.jsHeapDeltaMB),
    line: (s, v) => `${s.key}: +${fmt(v)} MB heap (${fmt(s.memory.jsHeapUsedMB)} MB in use)`,
  },
  {
    rule: "chatty-action",
    title: "Actions that fire many requests",
    hint: "One user action started many requests: per-keystroke requests without a debounce, one analytics beacon per event, or polling that started with it.",
    thresholds: SCAN_THRESHOLDS.actionRequests,
    warnSeverity: "medium",
    // A click that navigated loaded a page: its requests are that page's.
    value: (s, ctx) => (isLoad(s) || ctx.navigated(s) ? undefined : s.network.requestCount),
    line: (s, v) => `${s.key}: ${fmt(v)} requests, ${fmt(s.network.encodedKB)} KB`,
  },
  {
    rule: "slow-action",
    title: "Actions that take long to finish",
    hint: "The action's own work (its requests included) ran this long after the input. Long waits with a fast server usually mean serial work: one request, transaction or await per item, where one batched call would do.",
    thresholds: SCAN_THRESHOLDS.actionEffectiveMs,
    warnSeverity: "medium",
    // Not a click that navigated (that is a page load, graded by the vitals),
    // and not a step whose settle hit its cap (that is `never-idle`).
    value: (s, ctx) => (isLoad(s) || ctx.navigated(s) || s.capped ? undefined : effectiveMs(s)),
    line: (s, v) => `${s.key}: ${fmt(v)}ms until its work finished (span ${fmt(s.durationMs)}ms)`,
  },
  {
    rule: "request-waterfall",
    title: "Page loads with deep request chains",
    hint: "Requests that are only discovered after an earlier one finishes (script → fetch → fetch, CSS @import, module imports). Each wave adds a round trip; preload, flatten imports, or fetch in parallel.",
    thresholds: SCAN_THRESHOLDS.loadWaves,
    warnSeverity: "low",
    value: (s) => (isLoad(s) ? s.network.waves : undefined),
    line: (s, v) => `${s.key}: ${fmt(v)} serial request waves`,
  },
  {
    rule: "dropped-frames",
    title: "Janky steps (dropped frames)",
    hint: "The page missed display frames during the step: long tasks, layout-triggering animations, or heavy scroll handlers.",
    thresholds: SCAN_THRESHOLDS.droppedFrames,
    warnSeverity: "low",
    value: (s) => s.frames?.droppedFrames,
    line: (s, v) => `${s.key}: ${fmt(v)} dropped frames, worst ${fmt(s.frames!.longestFrameMs)}ms`,
  },
];

/** CDP resource types that are the app's own data requests. */
const API_TYPES = new Set(["Fetch", "XHR"]);
/** CDP resource types a browser should be able to cache across pages. */
const STATIC_TYPES = new Set(["Script", "Stylesheet", "Image", "Font", "Media"]);

function spanFindings(spans: readonly PerfSpanReport[], moved: ReadonlySet<PerfSpanReport>): ScanFinding[] {
  const out: ScanFinding[] = [];
  const ctx: SpanContext = { navigated: (s) => navigated(s) || moved.has(s) };
  for (const r of SPAN_RULES) {
    // Worst value per perfKey: a key the crawl hit several times is one place.
    const byKey = new Map<string, Located>();
    for (const s of spans) {
      const v = r.value(s, ctx);
      if (v === undefined || v < r.thresholds.warn) continue;
      const prev = byKey.get(s.key);
      if (!prev || v > prev.value) byKey.set(s.key, { where: s.key, value: v, line: r.line(s, v) });
    }
    if (byKey.size === 0) continue;
    const hits = [...byKey.values()];
    out.push(
      located(hits, {
        rule: r.rule,
        severity: severityOf(hits, r.thresholds, r.warnSeverity),
        category: "perf",
        title: r.title,
        hint: r.hint,
      }),
    );
  }

  const worstPerKey = (into: Map<string, Located>, hit: Located) => {
    const prev = into.get(hit.where);
    if (!prev || hit.value > prev.value) into.set(hit.where, hit);
  };
  const slow = new Map<string, Located>();
  const heavy = new Map<string, Located>();
  const dup = new Map<string, Located>();
  const perItem = new Map<string, Located>();
  const downloads = new Map<string, { path: string; loads: Set<string>; kb: number }>();
  for (const s of spans) {
    const exact = new Map<string, number>();
    const byEndpoint = new Map<string, Set<string>>();
    for (const q of s.network.requests) {
      const path = q.url.split("?")[0]!;
      if (q.durationMs >= SCAN_THRESHOLDS.slowRequestMs.warn) {
        worstPerKey(slow, { where: path, value: q.durationMs, line: `${path}: ${fmt(q.durationMs)}ms (${q.type}${q.thirdParty ? ", third-party" : ""})` });
      }
      if (q.kb >= SCAN_THRESHOLDS.resourceKB.warn) {
        worstPerKey(heavy, { where: path, value: q.kb, line: `${path}: ${fmt(q.kb)} KB (${q.type}${q.thirdParty ? ", third-party" : ""})` });
      }
      // The site's own API only (a third-party beacon repeating is the tag's
      // business), and only responses that were transferred: a second request
      // answered from cache costs nothing.
      if (API_TYPES.has(q.type) && !q.thirdParty) {
        if (q.kb > 0) exact.set(q.url, (exact.get(q.url) ?? 0) + 1);
        const label = endpointLabel(q.url);
        if (label?.includes(":id")) byEndpoint.set(label, (byEndpoint.get(label) ?? new Set()).add(q.url));
      }
      if (isLoad(s) && STATIC_TYPES.has(q.type) && q.kb > 0 && !q.url.startsWith("data:")) {
        // The same file: a full download is matched by path and size, so a
        // cache-busting query that changes on every load still matches; a
        // revalidation (a few hundred bytes of 304) by its whole URL, since an
        // image service serves many files from one path (`/_next/image?url=`).
        const revalidation = q.kb < 1;
        const id = revalidation ? q.url : `${path} ${Math.round(q.kb)}`;
        const d = downloads.get(id) ?? { path: revalidation ? q.url : path, loads: new Set<string>(), kb: 0 };
        d.loads.add(`${s.key}#${d.loads.size}`);
        d.kb = Math.max(d.kb, q.kb);
        downloads.set(id, d);
      }
    }
    for (const [url, n] of exact) {
      if (n < 2) continue;
      worstPerKey(dup, { where: s.key, value: n, line: `${s.key}: ${url} requested ${n}×` });
    }
    for (const [label, urls] of byEndpoint) {
      if (urls.size < SCAN_THRESHOLDS.perItemRequests.warn) continue;
      worstPerKey(perItem, { where: s.key, value: urls.size, line: `${s.key}: ${urls.size} requests to ${label}` });
    }
  }
  const push = (map: Map<string, Located>, f: Omit<ScanFinding, "where" | "occurrences" | "evidence" | "severity">, t: { poor: number }, warnSeverity: ScanSeverity) => {
    if (map.size === 0) return;
    const hits = [...map.values()];
    out.push(located(hits, { ...f, severity: severityOf(hits, t, warnSeverity) }));
  };
  push(
    slow,
    {
      rule: "slow-request",
      category: "perf",
      title: `Requests slower than ${SCAN_THRESHOLDS.slowRequestMs.warn}ms`,
      hint: "Slow server responses or large downloads. Check whether they are on the critical path, cacheable, or can be streamed / paginated.",
    },
    SCAN_THRESHOLDS.slowRequestMs,
    "low",
  );
  push(
    heavy,
    {
      rule: "heavy-resource",
      category: "perf",
      title: `Single responses over ${SCAN_THRESHOLDS.resourceKB.warn} KB`,
      hint: "One file or response this large: an unsubsetted font, an image at camera resolution, a bundle nobody split, or an API response with every field of every record.",
    },
    SCAN_THRESHOLDS.resourceKB,
    "medium",
  );
  push(
    dup,
    {
      rule: "duplicate-request",
      category: "perf",
      title: "The same API request made more than once in one step",
      hint: "Several components fetch the same thing, or a failed call is retried in a loop. Share one in-flight promise (a request cache), and bound retries.",
    },
    { poor: 5 },
    "medium",
  );
  push(
    perItem,
    {
      rule: "per-item-requests",
      category: "perf",
      title: "One request per item (N+1)",
      hint: "A request per row of a list: fetch them in one call (an ids= batch endpoint, or include the related data in the list response).",
    },
    SCAN_THRESHOLDS.perItemRequests,
    "medium",
  );
  const repeated: Located[] = [];
  for (const d of downloads.values()) {
    if (d.loads.size < SCAN_THRESHOLDS.repeatDownloads.warn) continue;
    const how = d.kb < 1 ? "revalidated (not reused from cache)" : "downloaded again";
    repeated.push({ where: d.path, value: d.loads.size, line: `${d.path}: ${how} on ${d.loads.size} page loads (${fmt(d.kb)} KB)` });
  }
  if (repeated.length > 0) {
    out.push(
      located(repeated, {
        rule: "repeat-download",
        severity: severityOf(repeated, SCAN_THRESHOLDS.repeatDownloads, "medium"),
        category: "perf",
        title: "Static files downloaded again on every page",
        hint: "The browser did not reuse its cached copy: no Cache-Control (or no-cache / must-revalidate on a file that never changes), or a URL that changes on every load. Fingerprint file names and serve them immutable.",
      }),
    );
  }
  return out;
}

// -------------------------------------------------------------- helpers

/** A step that created a document: a click that followed a link, a submit that reloaded. */
function navigated(s: PerfSpanReport): boolean {
  return (s.navigations ?? 0) > 0;
}

function isLoad(s: PerfSpanReport): boolean {
  return s.key.endsWith(" :: load");
}

function documentsOf(p: PageResult): Array<{ url: string; vitals: Record<string, { value: number }> }> {
  const s = p.perfPage!;
  if (s.documents && s.documents.length > 0) return s.documents;
  return [{ url: p.url, vitals: s.vitals }];
}

function severityOf(hits: readonly Located[], t: { poor: number }, warnSeverity: ScanSeverity): ScanSeverity {
  return hits.some((h) => h.value >= t.poor) ? "high" : warnSeverity;
}

function located(
  hits: Located[],
  f: Omit<ScanFinding, "where" | "occurrences" | "evidence">,
): ScanFinding {
  const sorted = [...hits].sort((a, b) => b.value - a.value);
  // One entry per location: a document's vitals can be reported by two visits.
  const seen = new Set<string>();
  const unique = sorted.filter((h) => (seen.has(h.where) ? false : (seen.add(h.where), true)));
  return {
    ...f,
    where: unique.slice(0, SCAN_WHERE_CAP).map((h) => h.where),
    occurrences: unique.length,
    evidence: unique.slice(0, SCAN_WHERE_CAP).map((h) => h.line),
  };
}

function capWhere(xs: readonly string[]): string[] {
  return [...new Set(xs)].slice(0, SCAN_WHERE_CAP);
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Math.abs(n) >= 100) return String(Math.round(n));
  if (Math.abs(n) >= 1) return String(Math.round(n * 10) / 10);
  return String(Math.round(n * 1000) / 1000);
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function firstStackFrame(stack: string): string {
  const frame = stack.split("\n").find((l) => /^\s*at\s/.test(l));
  return (frame ?? stack.split("\n")[0] ?? "").trim();
}
