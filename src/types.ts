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
