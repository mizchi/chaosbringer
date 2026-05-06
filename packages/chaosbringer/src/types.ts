/**
 * Core types for Chaos Crawler
 */

import type { AdvisorConfig } from "./advisor/types.js";
import type { ServerFaultEventAttrs } from "./server-fault-events.js";

export type { AdvisorConfig } from "./advisor/types.js";

export interface CrawlerOptions {
  /** Base URL to start crawling */
  baseUrl: string;
  /** Maximum number of pages to visit */
  maxPages?: number;
  /** Maximum random actions per page */
  maxActionsPerPage?: number;
  /** Page load timeout in ms */
  timeout?: number;
  /** Run browser in headless mode */
  headless?: boolean;
  /** Take screenshots of visited pages */
  screenshots?: boolean;
  /** Directory to save screenshots */
  screenshotDir?: string;
  /** URL patterns to exclude (regex strings) */
  excludePatterns?: string[];
  /** Error message patterns to ignore (regex strings) */
  ignoreErrorPatterns?: string[];
  /** URL patterns to treat as SPA (regex strings) - errors from these are categorized separately */
  spaPatterns?: string[];
  /** Viewport size */
  viewport?: { width: number; height: number };
  /** Custom user agent */
  userAgent?: string;
  /** Block navigation to external domains */
  blockExternalNavigation?: boolean;
  /**
   * Inject a fresh W3C `traceparent` header onto every request the browser
   * sends. Pair with an OTel-instrumented server to correlate browser-driven
   * actions with server-side traces.
   *
   * - `true` / `{}`        — generate a new trace per request.
   * - `false` / undefined  — do nothing (default).
   * - `{ onInject }`       — also receive the generated traceparent so the
   *                          consumer can stash it in their own report.
   *
   * Existing `traceparent` headers (e.g. set by another middleware) are left
   * alone so explicit propagation always wins.
   */
  traceparent?: boolean | TraceparentInjectionOptions;
  /** Action weighting configuration */
  actionWeights?: ActionWeights;
  /** Log file path (enables file logging) */
  logFile?: string;
  /** Log level */
  logLevel?: "debug" | "info" | "warn" | "error";
  /** Also log to console */
  logToConsole?: boolean;
  /** Enable recovery from 404/dead links */
  enableRecovery?: boolean;
  /** Number of recent operations to keep for recovery dump */
  recoveryHistorySize?: number;
  /** Seed for deterministic action selection. Random if omitted. */
  seed?: number;
  /** Assertions to evaluate on each page. */
  invariants?: Invariant[];
  /** Fault injection rules applied via Playwright's route API. */
  faultInjection?: FaultRule[];
  /**
   * Page-lifecycle fault injection. Each fault fires at a specific stage of a
   * page visit and perturbs the browser side (CPU throttle, storage wipe,
   * Service Worker cache eviction, …). Distinct from `faultInjection`, which
   * acts on individual network requests.
   */
  lifecycleFaults?: LifecycleFault[];
  /**
   * JS-runtime fault injection. Each fault is a persistent monkey-patch
   * installed via `addInitScript` on every page navigation, subverting
   * in-page JS APIs (fetch / Date / performance / etc.) so the app sees
   * client-side failures that no network mock would expose. Distinct from
   * `faultInjection` (request-scoped) and `lifecycleFaults` (one-shot at
   * named stages).
   */
  runtimeFaults?: RuntimeFault[];
  /**
   * Opt-in coverage-guided action selection. When enabled, the crawler
   * attaches a V8 precise-coverage collector (CDP `Profiler.takePreciseCoverage`)
   * to every page, attributes per-action coverage deltas to the target that
   * fired them, and biases subsequent action weighting toward targets that
   * historically delivered new coverage. Reproducibility now spans
   * `(seed, coverageFeedback)` — same seed + same feedback config → same
   * action sequence.
   */
  coverageFeedback?: CoverageFeedbackOptions;
  /** HAR record/replay configuration for deterministic network state. */
  har?: HarConfig;
  /**
   * Per-metric performance budget (in ms). Keys match PerformanceMetrics;
   * omitted keys are not enforced. A breach is recorded as an invariant
   * violation, so it always fails the run.
   */
  performanceBudget?: PerformanceBudget;
  /**
   * Path to write a JSONL trace of every navigation + action performed. Used
   * as input to replay mode and to the `minimize` subcommand — the exact
   * crawl can be replayed without rerolling the RNG.
   */
  traceOut?: string;
  /**
   * Path to a trace file produced by `traceOut`. When set, the crawler
   * ignores its weighted-random driver and plays back the recorded visits
   * and actions verbatim.
   */
  traceReplay?: string;
  /**
   * URL or filesystem path to a sitemap.xml (or sitemap index). Every URL
   * listed — including URLs resolved via nested indexes — is prepended to
   * the crawl queue before discovered links, filtered to the same origin
   * as `baseUrl`. Useful for sites whose nav is JS-rendered and so missed
   * by the crawler's link extraction.
   */
  seedFromSitemap?: string;
  /**
   * Name of a Playwright device descriptor to emulate (e.g. "iPhone 14",
   * "Pixel 7", "iPad Pro 11"). Applied to the browser context — sets
   * viewport, userAgent, deviceScaleFactor, isMobile, and hasTouch.
   */
  device?: string;
  /**
   * Network throttling preset applied via CDP on every page. Supported:
   * "slow-3g" / "fast-3g" / "offline". Omit to use the default network.
   */
  network?: NetworkProfile;
  /**
   * Path to a Playwright storage state file (cookies + localStorage) to
   * preload into the browser context. Lets the crawler start a run as an
   * already-authenticated user — generate the file with
   * `await context.storageState({ path })` in a login script, then point
   * this at it. The file is not modified by the crawl.
   */
  storageState?: string;
  /**
   * 0-based index of this shard in a parallel run. Must be paired with
   * `shardCount`. The crawler hashes every discovered URL and only processes
   * those where `hash(url) % shardCount === shardIndex`. `baseUrl` is always
   * processed regardless of hash so every shard can seed its BFS.
   */
  shardIndex?: number;
  /** Total number of shards in a parallel run. Must be >= 1. */
  shardCount?: number;
  /**
   * Per-failure artifact bundling. When set, every page that errors,
   * times out, crashes, or surfaces invariant violations gets its own
   * directory under `dir` containing the screenshot, HTML, error list,
   * trace up to that point, and a `repro.sh` to replay it. Designed to
   * make a CI failure self-contained — drop the bundle into an issue
   * and the reader can reproduce locally.
   */
  failureArtifacts?: FailureArtifactsOptions;
  /**
   * Opt-in vision-language model advisor that picks the next action
   * when the coverage-guided heuristic stalls. See
   * `docs/superpowers/specs/2026-05-01-vlm-action-advisor-design.md`.
   * Default: undefined (advisor disabled, zero overhead).
   */
  advisor?: AdvisorConfig;
  /** @internal Set by `chaos({ server })`. */
  server?: ChaosRemoteServer;
}

/**
 * Options for `CrawlerOptions.traceparent`. The hook lets the consumer
 * stash the generated trace ID alongside their own per-request data
 * (e.g. for cross-referencing the browser-side action log with a
 * server-side OTel trace).
 */
export interface TraceparentInjectionOptions {
  /**
   * Called once per request *after* the traceparent header is decided.
   * `traceparent` is the full W3C value, `traceId` and `spanId` are the
   * pre-split components (32-hex / 16-hex).
   *
   * If the request already carried a `traceparent` header (e.g. set by
   * an outer middleware), the existing value is forwarded as-is and
   * `existing` is `true`. Consumers can use this to avoid double-counting.
   */
  onInject?: (info: {
    url: string;
    method: string;
    traceparent: string;
    traceId: string;
    spanId: string;
    existing: boolean;
  }) => void;
}

export interface FailureArtifactsOptions {
  /** Directory under which one subdirectory per failure is created. */
  dir: string;
  /** Save the page's HTML (default: true). */
  saveHtml?: boolean;
  /** Save the screenshot (default: true). */
  saveScreenshot?: boolean;
  /** Save the trace up to and including the failing page (default: true). */
  saveTrace?: boolean;
  /** Cap the number of bundles per run (default: unlimited). */
  maxArtifacts?: number;
}

/** `record` captures responses to a HAR file; `replay` serves them back. */
export type HarMode = "record" | "replay";

export interface HarConfig {
  /** Filesystem path to the HAR file. */
  path: string;
  mode: HarMode;
  /**
   * When replaying and a request has no match in the HAR, fall through to the
   * network (`"fallback"`, default) or fail it (`"abort"`).
   */
  notFound?: "fallback" | "abort";
}

import type { ErrorCluster } from "./clusters.js";
export type { ErrorCluster };

// Network / lifecycle / runtime fault types now live in
// @mizchi/playwright-faults — re-exported here for backwards compatibility
// (and to satisfy CrawlerOptions / CrawlReport references in this file).
import type {
  Fault,
  FaultInjectionStats,
  FaultRule,
  LifecycleAction,
  LifecycleFault,
  LifecycleFaultStats,
  LifecycleStage,
  RuntimeAction,
  RuntimeFault,
  RuntimeFaultStats,
  StorageScope,
  UrlMatcher,
} from "@mizchi/playwright-faults";

export type {
  Fault,
  FaultInjectionStats,
  FaultRule,
  LifecycleAction,
  LifecycleFault,
  LifecycleFaultStats,
  LifecycleStage,
  RuntimeAction,
  RuntimeFault,
  RuntimeFaultStats,
  StorageScope,
  UrlMatcher,
};

// LifecycleStage, StorageScope, LifecycleAction, LifecycleFault re-exported above
// from @mizchi/playwright-faults.

/**
 * Configuration for coverage-guided action selection.
 *
 * Off by default. When `enabled`, the crawler:
 *   1. Attaches a V8 precise-coverage collector to every page via CDP.
 *   2. After each chaos action, computes the set of functions newly executed
 *      since the previous action.
 *   3. Filters that set against a global "already-seen" set; the residual is
 *      the truly novel contribution of that action.
 *   4. Stores `targetNovelty[(url, selector)] += novelCount`.
 *   5. On the next visit (same or different page), multiplies each action
 *      target's weight by `1 + boost · log(1 + targetNovelty[key])`.
 *
 * No extra RNG draws — the seed sequence is unchanged. The action sequence
 * still differs from a no-feedback run because the weight inputs to
 * `weightedPick` differ, so reproducibility is a tuple of `(seed, this
 * config)`.
 */
export interface CoverageFeedbackOptions {
  /** Master switch. Default: false (no coverage hooks attached). */
  enabled: boolean;
  /**
   * Multiplier applied via `1 + boost · log1p(score)`. `0` disables the
   * weight bias (coverage still tracked / reported). `1` gives a gentle
   * bias; `2` (default) noticeably reorders actions; `4` aggressively
   * concentrates picks on the top-scoring targets.
   */
  boost?: number;
  /** Cap top-N novel targets emitted in `report.coverage`. Default: 20. */
  topN?: number;
}

/**
 * Coverage summary attached to `CrawlReport.coverage` when
 * `coverageFeedback.enabled` was true.
 */
export interface CoverageReport {
  /** Total distinct V8 function fingerprints executed during this run. */
  totalFunctions: number;
  /** Number of pages whose visit yielded at least one new function. */
  pagesWithNewCoverage: number;
  /**
   * Top action targets by historical novelty score, sorted desc. Capped by
   * `topN`. The `selector` is the same one chaosbringer uses to pick the
   * target — useful when interpreting which interactions are pulling weight
   * up across pages.
   */
  topNovelTargets: Array<{
    url: string;
    selector: string;
    score: number;
  }>;
}

// LifecycleFaultStats, RuntimeAction, RuntimeFault, RuntimeFaultStats re-exported above
// from @mizchi/playwright-faults.

export interface ActionWeights {
  /** Weight for navigation links (default: 3) */
  navigationLinks?: number;
  /** Weight for buttons (default: 2) */
  buttons?: number;
  /** Weight for form inputs (default: 1) */
  inputs?: number;
  /** Weight for interactive elements with aria roles (default: 2) */
  ariaInteractive?: number;
  /** Weight for elements with visible text (default: 1.5) */
  visibleText?: number;
  /** Weight for scroll actions (default: 0.5) */
  scroll?: number;
}

export interface PageError {
  type:
    | "console"
    | "network"
    | "exception"
    | "crash"
    | "unhandled-rejection"
    | "invariant-violation";
  message: string;
  url?: string;
  stack?: string;
  timestamp: number;
  /** Name of the invariant that failed (only for invariant-violation errors). */
  invariantName?: string;
}

/**
 * Assertion that must hold on every page the crawler visits. Failures are
 * surfaced as PageError with type "invariant-violation".
 *
 * The `check` function may return false, throw, or return a string describing
 * the violation. Returning true (or void) means the invariant holds.
 */
export interface Invariant {
  /** Human-readable identifier used in error messages. */
  name: string;
  /** Check the invariant. Return false / throw / return a string to fail. */
  check: (ctx: InvariantContext) => boolean | string | void | Promise<boolean | string | void>;
  /** When to evaluate. Default: "afterActions". */
  when?: "afterLoad" | "afterActions";
  /** Restrict to URLs matching this matcher (regex literal or regex string). Omit to run on every page. */
  urlPattern?: UrlMatcher;
}

export interface InvariantContext {
  /** Playwright Page object — use this to query the DOM / evaluate. */
  page: import("playwright").Page;
  /** URL of the page being checked. */
  url: string;
  /** Errors collected on this page so far. */
  errors: readonly PageError[];
  /**
   * Mutable, run-scoped key/value bag shared between invariants. The same
   * `Map` instance is passed to every invariant on every page during a run,
   * so invariants can carry state across pages and detect trans-page issues
   * (state-machine transitions, monotonic counters, set-membership
   * regressions). Reset at the start of each `crawler.start()` call.
   */
  state: Map<string, unknown>;
}

export interface PerformanceMetrics {
  /** Time to first byte */
  ttfb?: number;
  /** First contentful paint */
  fcp?: number;
  /** Largest contentful paint */
  lcp?: number;
  /** Total blocking time approximation */
  tbt?: number;
  /** DOM content loaded */
  domContentLoaded?: number;
  /** Full page load */
  load?: number;
}

/**
 * Per-metric budget (in ms). A page whose measured metric exceeds the budget
 * is recorded as an invariant violation named `perf-budget.<metric>`, which
 * forces a non-zero exit and shows up in the diff section.
 */
export interface PerformanceBudget {
  ttfb?: number;
  fcp?: number;
  lcp?: number;
  tbt?: number;
  domContentLoaded?: number;
  load?: number;
}

/** Supported network throttling presets applied via CDP. */
export type NetworkProfile = "slow-3g" | "fast-3g" | "offline";

export const NETWORK_PROFILES = ["slow-3g", "fast-3g", "offline"] as const satisfies ReadonlyArray<NetworkProfile>;

/** Keys of PerformanceMetrics that a budget can target. */
export const PERF_BUDGET_KEYS = [
  "ttfb",
  "fcp",
  "lcp",
  "tbt",
  "domContentLoaded",
  "load",
] as const satisfies ReadonlyArray<keyof PerformanceMetrics>;

export type PerfBudgetKey = (typeof PERF_BUDGET_KEYS)[number];

export interface PageResult {
  url: string;
  /**
   * Outcome of the navigation, not the page overall. A page can have
   * `status: "success"` but still contain console errors / exceptions /
   * unhandled rejections — check `hasErrors` or `errors.length` to
   * judge page health.
   */
  status: "success" | "error" | "timeout" | "recovered";
  statusCode?: number;
  loadTime: number;
  errors: PageError[];
  /** True when `errors.length > 0`. Computed once when the result is built. */
  hasErrors: boolean;
  warnings: string[];
  metrics?: PerformanceMetrics;
  links: string[];
  screenshot?: string;
  blockedNavigations?: string[];
  /** Recovery info if page was recovered from error */
  recovery?: RecoveryInfo;
  /** How this page was discovered */
  discoveryMethod?: DiscoveryMethod;
  /** URL of the page that linked to this page */
  sourceUrl?: string;
  /** Element that linked to this page */
  sourceElement?: string;
  /**
   * Server-side fault events that fired while this page was active.
   * Pre-computed view of `report.serverFaults` filtered by `pageUrl`.
   * Populated only when `chaos({ server: { mode: "remote" } })` was set
   * AND faults were observed on this page; absent otherwise.
   *
   * References are shared with `report.serverFaults[]` — no duplication.
   */
  serverFaultEvents?: ServerFaultEvent[];
}

export interface RecoveryInfo {
  /** URL that caused the error */
  failedUrl: string;
  /** Error that triggered recovery */
  error: string;
  /** URL recovered to */
  recoveredTo: string;
  /** Recent actions before failure */
  recentActions: ActionResult[];
  /** Timestamp of recovery */
  timestamp: number;
}

export interface ActionTarget {
  selector: string;
  role?: string;
  name?: string;
  weight: number;
  type: "link" | "button" | "input" | "interactive" | "scroll";
  /** For links, the href attribute */
  href?: string;
}

export interface ActionResult {
  type: "click" | "scroll" | "hover" | "navigate" | "input";
  target?: string;
  selector?: string;
  success: boolean;
  error?: string;
  blockedExternal?: boolean;
  /** True when the action was skipped because the target URL is owned by another shard. */
  shardSkipped?: boolean;
  timestamp: number;
  /**
   * W3C trace-ids of requests triggered while this action was executing.
   * Populated only when `chaos({ traceparent: true })` is set. Absent for
   * actions that triggered no requests (scroll, hover) or when traceparent
   * injection is off.
   */
  traceIds?: string[];
  /**
   * Server-side fault events whose `traceId` is in `traceIds[]`. Pre-
   * computed view of `report.serverFaults` per action. Populated only when
   * `chaos({ traceparent: true, server: { mode: "remote" } })` is BOTH set
   * AND at least one fault joined to this action.
   */
  serverFaultEvents?: ServerFaultEvent[];
}

/**
 * One entry in a cluster-level diff between two runs. `before` is the count in
 * the baseline report; `after` is the count in the current report. New clusters
 * have `before: 0`; resolved clusters have `after: 0`.
 */
export interface ClusterDiffEntry {
  key: string;
  type: PageError["type"];
  fingerprint: string;
  before: number;
  after: number;
}

/**
 * One entry in a page-level diff. A page is considered "failed" when it has
 * any errors, or its navigation ended in `error` / `timeout`. Pages appear in
 * the diff only when their failed/clean state differs between runs.
 */
export interface PageDiffEntry {
  url: string;
  /** null when the page did not exist in the baseline. */
  before: { errors: number; status: PageResult["status"] } | null;
  /** null when the page was not visited in the current run. */
  after: { errors: number; status: PageResult["status"] } | null;
}

/**
 * Diff between a baseline report and the current report. Produced by
 * `diffReports(prev, curr)`, attached to the current report as `report.diff`
 * when a baseline was supplied.
 */
export interface ReportDiff {
  /** Path the baseline was loaded from, if known. */
  baselinePath?: string;
  /** Seed of the baseline run — useful for asserting like-vs-like. */
  baselineSeed: number;
  /** Clusters present in the current run but not the baseline. */
  newClusters: ClusterDiffEntry[];
  /** Clusters present in the baseline but not the current run. */
  resolvedClusters: ClusterDiffEntry[];
  /** Clusters present in both runs (with potentially different counts). */
  unchangedClusters: ClusterDiffEntry[];
  /** Pages that are failing in the current run but were clean in the baseline (or not visited). */
  newFailedPages: PageDiffEntry[];
  /** Pages that were failing in the baseline but are clean / absent in the current run. */
  resolvedFailedPages: PageDiffEntry[];
}

export interface CrawlReport {
  baseUrl: string;
  /** Seed used for random action selection (for reproducibility). */
  seed: number;
  /**
   * Copy-pasteable CLI invocation that reproduces this run. Only includes
   * CLI-expressible options; programmatic-only options (invariants,
   * faultInjection) cannot be encoded in a shell command and are omitted.
   */
  reproCommand: string;
  startTime: number;
  endTime: number;
  duration: number;
  pagesVisited: number;
  totalErrors: number;
  totalWarnings: number;
  blockedExternalNavigations: number;
  recoveryCount: number;
  pages: PageResult[];
  actions: ActionResult[];
  summary: CrawlSummary;
  /** Per-rule fault injection stats (present only when rules were configured). */
  faultInjections?: FaultInjectionStats[];
  /**
   * Per-fault lifecycle fault stats (present only when `lifecycleFaults` was
   * configured). One row per `LifecycleFault`, regardless of how many pages
   * matched.
   */
  lifecycleFaults?: LifecycleFaultStats[];
  /**
   * Per-fault runtime fault stats (present only when `runtimeFaults` was
   * configured). Counts are accumulated across every page visit's
   * `window.__chaosbringerRuntimeStats` snapshot.
   */
  runtimeFaults?: RuntimeFaultStats[];
  /**
   * Coverage-feedback summary (present only when `coverageFeedback.enabled`
   * was true). Reports total V8 functions executed, how many pages produced
   * new coverage, and the top-N action targets by historical novelty.
   */
  coverage?: CoverageReport;
  /**
   * Action-advisor activity (present only when `advisor` was configured).
   * Reports the provider, attempt + success counts, and one row per pick
   * the advisor actually made — useful for auditing which crawl decisions
   * were model-driven vs heuristic-driven.
   */
  advisor?: AdvisorReport;
  /**
   * Errors grouped into clusters by fingerprint (type + normalised message).
   * Use `ErrorCluster.count` to triage noisy runs where the same issue fires
   * repeatedly. Always populated, even when empty.
   */
  errorClusters: ErrorCluster[];
  /** Echo of the HAR config used for this run, if any. */
  har?: HarConfig;
  /** Diff against a baseline report, present only when a baseline was supplied. */
  diff?: ReportDiff;
  /**
   * Drift signal for `--trace-replay` runs. Present only when traceReplay
   * was set. Reports how many of the recorded trace actions resolved
   * cleanly against the current UI vs. drifted (selector missing, threw,
   * etc.) — surfaces UI drift before stale traces silently start producing
   * meaningless replays.
   */
  replayFidelity?: ReplayFidelity;
  /**
   * Server-side fault events ingested via response headers (present only
   * when `chaos({ server: { mode: "remote" } })` was set and the server
   * was emitting `x-chaos-fault-*` headers via `@mizchi/server-faults`).
   * Flat list across the whole run; consumers join by `traceId` for
   * per-action correlation.
   */
  serverFaults?: ServerFaultEvent[];
}

export interface ReplayFidelity {
  /** Total trace actions attempted (excludes meta + visit entries). */
  totalActions: number;
  succeeded: number;
  /** Recorded selector did not resolve / element not visible. */
  selectorMissing: number;
  /** Recorded action had no selector (e.g. scroll fallback). */
  noSelectorRecorded: number;
  /** Replay threw (e.g. navigation timeout, click timeout). */
  threw: number;
}

export interface AdvisorPick {
  url: string;
  reason: "novelty_stall" | "invariant_violation" | "explicit_request";
  chosenSelector: string;
  reasoning: string;
}

export interface AdvisorReport {
  provider: string;
  callsAttempted: number;
  callsSucceeded: number;
  picks: AdvisorPick[];
}

export interface CrawlSummary {
  successPages: number;
  errorPages: number;
  timeoutPages: number;
  recoveredPages: number;
  /** Pages where `errors.length > 0`, independent of navigation status. */
  pagesWithErrors: number;
  consoleErrors: number;
  networkErrors: number;
  jsExceptions: number;
  unhandledRejections: number;
  invariantViolations: number;
  avgLoadTime: number;
  avgMetrics?: {
    ttfb: number;
    fcp: number;
    lcp: number;
  };
  /** Discovery metrics - how links were found */
  discovery?: DiscoveryMetrics;
}

/** How a URL was discovered */
export type DiscoveryMethod = "initial" | "extracted" | "clicked" | "navigated";

/** Entry in the crawl queue with source tracking */
export interface QueueEntry {
  url: string;
  /** URL of the page where this link was found */
  sourceUrl: string;
  /** How this link was discovered */
  method: DiscoveryMethod;
  /** Element text/selector that contained the link */
  sourceElement?: string;
}

/** Metrics about how links were discovered */
export interface DiscoveryMetrics {
  /** Links found via extraction (parsing HTML) */
  extractedLinks: number;
  /** Links discovered via click actions */
  clickedLinks: number;
  /** Unique pages reached */
  uniquePages: number;
  /** Dead links found with their sources */
  deadLinks: DeadLinkInfo[];
  /** SPA-related issues (expected errors from client-side routing) */
  spaIssues: SpaIssueInfo[];
}

/** Information about a SPA-related issue */
export interface SpaIssueInfo {
  /** The URL that had the issue */
  url: string;
  /** Type of issue */
  type: "routing-404" | "internal-error" | "hydration-error";
  /** Error message */
  message: string;
  /** Pattern that matched as SPA */
  matchedPattern: string;
}

/** Information about a dead link */
export interface DeadLinkInfo {
  /** The broken URL */
  url: string;
  /** HTTP status code */
  statusCode: number;
  /** Where the link was found */
  sourceUrl: string;
  /** Element that contained the link */
  sourceElement?: string;
  /** How it was discovered */
  method: DiscoveryMethod;
}

export interface CrawlerEvents {
  onPageStart?: (url: string) => void;
  onPageComplete?: (result: PageResult) => void;
  onError?: (error: PageError) => void;
  onAction?: (action: ActionResult) => void;
  onProgress?: (visited: number, total: number) => void;
  onBlockedNavigation?: (url: string) => void;
}

/**
 * Server-side fault ingestion mode. Phase 1 supports `"remote"`: the server
 * runs in a different process and emits `x-chaos-fault-*` response headers
 * via `@mizchi/server-faults`'s `metadataHeader` option. chaos() listens for
 * those headers and surfaces the events on `CrawlReport.serverFaults`.
 */
export interface ChaosRemoteServer {
  mode: "remote";
  /** Header prefix to look for. Default `"x-chaos-fault"`. */
  responseHeaderPrefix?: string;
}

export interface ServerFaultEvent {
  /** Trace-id from the response headers (W3C traceparent's trace-id segment). */
  traceId?: string;
  /**
   * Flat camelCase attrs mirroring `@mizchi/server-faults`'s `FaultAttrs`.
   * Aliased to `ServerFaultEventAttrs` (the parser's own type) so adding a
   * new fault kind is a single edit instead of two — see
   * `server-fault-events.ts` for the canonical shape.
   */
  attrs: ServerFaultEventAttrs;
  /** Wall-clock ms when chaos observed the response. */
  observedAt: number;
  /** URL of the page that triggered the request. */
  pageUrl: string;
}

/** Configuration for Playwright Test integration */
export interface ChaosTestOptions {
  /** Base URL (uses baseURL from Playwright config if not set) */
  baseUrl?: string;
  /** Maximum pages to visit per test */
  maxPages?: number;
  /** Maximum actions per page */
  maxActionsPerPage?: number;
  /** Patterns to ignore */
  ignoreErrorPatterns?: string[];
  /** Block external navigation */
  blockExternalNavigation?: boolean;
  /** Fail test on any error */
  strict?: boolean;
  /** Action weights */
  actionWeights?: ActionWeights;
}
