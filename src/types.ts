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
  timestamp: number;
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
