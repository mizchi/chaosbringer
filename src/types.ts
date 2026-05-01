/**
 * Core types for Chaos Crawler
 */

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

/** What to do when a FaultRule matches a request. */
export type Fault =
  | { kind: "abort"; errorCode?: string }
  | { kind: "status"; status: number; body?: string; contentType?: string }
  | { kind: "delay"; ms: number };

/** Anything that can match a URL. String inputs are compiled with `new RegExp`. */
export type UrlMatcher = string | RegExp;

export interface FaultRule {
  /** Optional human-readable name used in stats. */
  name?: string;
  /** URL matcher — a regex literal or a regex string. */
  urlPattern: UrlMatcher;
  /** HTTP methods to match (case-insensitive). Empty = all methods. */
  methods?: string[];
  /** Action taken on a match. */
  fault: Fault;
  /** 0..1, default 1.0. Uses the crawler's seeded RNG. */
  probability?: number;
}

/** Per-rule stats for fault injection, emitted on the final report. */
export interface FaultInjectionStats {
  rule: string;
  matched: number;
  injected: number;
}

/**
 * When during a page's lifecycle a `LifecycleFault` fires.
 *
 * - `beforeNavigation`: before `page.goto` — for CDP-level conditions that need to
 *   apply during the load itself (CPU throttle, virtual time).
 * - `afterLoad`: right after navigation completes, before any chaos actions or
 *   `afterLoad` invariants run — for in-page mutations (storage clears, tamper).
 * - `beforeActions`: after `afterLoad` invariants pass, before the first chaos
 *   action — for one-shot evictions that should not affect invariants but should
 *   precede user simulation (Service Worker cache eviction).
 * - `betweenActions`: after every chaos action — for sustained pressure faults
 *   that need re-application across the action loop.
 */
export type LifecycleStage =
  | "beforeNavigation"
  | "afterLoad"
  | "beforeActions"
  | "betweenActions";

/** Where a `clear-storage` / `tamper-storage` action targets. */
export type StorageScope = "localStorage" | "sessionStorage" | "cookies" | "indexedDB";

/**
 * What a lifecycle fault does when it fires.
 *
 * Distinct from network-side `Fault` (which is request-scoped). These are
 * page-scoped client-side perturbations applied via the Playwright Page /
 * BrowserContext / CDP session.
 */
export type LifecycleAction =
  /**
   * Apply CPU throttling via CDP `Emulation.setCPUThrottlingRate`.
   * `rate` is a multiplier ≥ 1 (1 = no throttle, 4 = ~4× slower).
   */
  | { kind: "cpu-throttle"; rate: number }
  /** Wipe one or more storage scopes. */
  | { kind: "clear-storage"; scopes: StorageScope[] }
  /**
   * Drop entries from the Service Worker `caches` API. When `cacheNames` is
   * omitted, every cache is dropped.
   */
  | { kind: "evict-cache"; cacheNames?: string[] }
  /**
   * Set a single key/value in `localStorage` or `sessionStorage`. Useful for
   * forcing a logged-in app into "stale auth token" state and similar
   * targeted-corruption scenarios.
   */
  | {
      kind: "tamper-storage";
      scope: "localStorage" | "sessionStorage";
      key: string;
      value: string;
    };

/**
 * Page-level fault injected at a specific lifecycle stage. Network-level faults
 * stay on `FaultRule` (URL-matched, applied via Playwright `route()`).
 */
export interface LifecycleFault {
  /** Optional human-readable name used in stats. Auto-derived when omitted. */
  name?: string;
  /** When during the page lifecycle this fault fires. */
  when: LifecycleStage;
  /**
   * Restrict to URLs matching this matcher. Omit to apply on every page. For
   * `beforeNavigation` faults the about-to-be-navigated URL is matched.
   */
  urlPattern?: UrlMatcher;
  /** 0..1, default 1.0. Uses the crawler's seeded RNG. */
  probability?: number;
  /** What to do when the fault fires. */
  action: LifecycleAction;
}

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

/** Per-fault stats emitted on the final report. */
export interface LifecycleFaultStats {
  /** `name` from the `LifecycleFault`, or an auto-derived label. */
  name: string;
  /** Pages whose URL matched (regardless of probability). */
  matched: number;
  /** Pages where the fault actually fired (after the probability roll). */
  fired: number;
  /** Pages where the fault threw while firing. */
  errored: number;
}

/**
 * What a runtime fault does when it fires. Each kind is a persistent
 * monkey-patch installed in every page via `addInitScript`.
 */
export type RuntimeAction =
  /**
   * Reject `window.fetch` calls before any network round-trip. Different
   * from a network `Fault` of kind `"abort"`: `flaky-fetch` rejects the
   * Promise client-side with a TypeError, simulating "Failed to fetch" /
   * Service Worker reject / DNS failure.
   */
  | { kind: "flaky-fetch"; rejectionMessage?: string }
  /**
   * Skew `Date.now()` / `performance.now()` (and the no-arg `Date`
   * constructor) forward by `skewMs`. Useful for forcing token-expiry,
   * cache-bust, and "clock drift" code paths.
   */
  | { kind: "clock-skew"; skewMs: number };

/**
 * Page-level JS-runtime fault. Installed via `addInitScript` on every page
 * navigation. Distinct from `FaultRule` (request-scoped) and
 * `LifecycleFault` (one-shot at named stages of a page visit).
 */
export interface RuntimeFault {
  /** Optional human-readable name used in stats. Auto-derived when omitted. */
  name?: string;
  /**
   * Restrict to pages whose URL matches this matcher. Omitted = applies on
   * every page. The check happens inside the page (against `location.href`),
   * so the matcher must be JSON-serializable (string regex or RegExp literal).
   */
  urlPattern?: UrlMatcher;
  /** 0..1, default 1.0. Rolled per call against an in-page seeded RNG. */
  probability?: number;
  /** What to do when the fault fires. */
  action: RuntimeAction;
}

/** Per-fault stats for runtime fault injection, emitted on the final report. */
export interface RuntimeFaultStats {
  /** `name` from the `RuntimeFault`, or an auto-derived label. */
  rule: string;
  /** Times the fault was tested (URL matched, probability about to roll). */
  matched: number;
  /** Times the fault actually fired. */
  fired: number;
}

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
   * Errors grouped into clusters by fingerprint (type + normalised message).
   * Use `ErrorCluster.count` to triage noisy runs where the same issue fires
   * repeatedly. Always populated, even when empty.
   */
  errorClusters: ErrorCluster[];
  /** Echo of the HAR config used for this run, if any. */
  har?: HarConfig;
  /** Diff against a baseline report, present only when a baseline was supplied. */
  diff?: ReportDiff;
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
