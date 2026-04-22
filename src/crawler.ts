/**
 * ChaosCrawler - Playwright-based chaos testing crawler
 */

import type { Browser, BrowserContext, Page, Route } from "playwright";
import { chromium } from "playwright";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  CrawlerOptions,
  CrawlerEvents,
  PageResult,
  PageError,
  ActionResult,
  ActionTarget,
  ActionWeights,
  PerformanceMetrics,
  CrawlReport,
  CrawlSummary,
  RecoveryInfo,
  QueueEntry,
  DiscoveryMetrics,
  DeadLinkInfo,
  DiscoveryMethod,
  SpaIssueInfo,
  Invariant,
  FaultRule,
  FaultInjectionStats,
  Fault,
  UrlMatcher,
} from "./types.js";
import { Logger, createNullLogger } from "./logger.js";
import {
  matchesAnyPattern,
  matchesSpaPattern as matchesSpaPatternPure,
  isExternalUrl as isExternalUrlPure,
  escapeSelector as escapeSelectorPure,
  summarizePages,
  normalizeUrl,
} from "./filters.js";
import { createRng, randomSeed, weightedPick, randomInt, type Rng } from "./random.js";
import { clusterErrors } from "./clusters.js";

// Options that are opt-in with no meaningful default (HAR, storage state) are
// carved out of the Required<> type instead of inventing sentinels.
const DEFAULT_OPTIONS: Required<Omit<CrawlerOptions, "baseUrl" | "har" | "storageState">> = {
  maxPages: 50,
  maxActionsPerPage: 5,
  timeout: 30000,
  headless: true,
  screenshots: false,
  screenshotDir: "./screenshots",
  excludePatterns: [],
  ignoreErrorPatterns: [],
  spaPatterns: [],
  viewport: { width: 1280, height: 720 },
  userAgent: "",
  blockExternalNavigation: true,
  actionWeights: {},
  logFile: "",
  logLevel: "info",
  logToConsole: false,
  enableRecovery: true,
  recoveryHistorySize: 20,
  seed: 0, // Overwritten at construction time if unset
  invariants: [],
  faultInjection: [],
};

const DEFAULT_ACTION_WEIGHTS: Required<ActionWeights> = {
  navigationLinks: 3,
  buttons: 2,
  inputs: 1,
  ariaInteractive: 2,
  visibleText: 1.5,
  scroll: 0.5,
};

// Common third-party scripts to ignore in dev mode
export const COMMON_IGNORE_PATTERNS = [
  "cloudflareinsights\\.com",
  "googletagmanager\\.com",
  "google-analytics\\.com",
  "analytics\\.google\\.com",
  "facebook\\.net",
  "connect\\.facebook\\.net",
  "hotjar\\.com",
  "clarity\\.ms",
  "segment\\.io",
  "amplitude\\.com",
  // Generic error message from blocked resources
  "Failed to load resource: net::ERR_FAILED$",
];

export class ChaosCrawler {
  private options: Required<CrawlerOptions>;
  private actionWeights: Required<ActionWeights>;
  private events: CrawlerEvents;
  private logger: Logger;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private visited: Set<string> = new Set();
  private queue: QueueEntry[] = [];
  private results: PageResult[] = [];
  private actions: ActionResult[] = [];
  private blockedExternalCount = 0;
  private startTime = 0;
  private baseOrigin: string;
  /** Actions performed on the page currently being crawled. Reset on
   * every new crawlPage call so the recovery dump only reports actions
   * from the page that actually failed. */
  private currentPageActions: ActionResult[] = [];
  /** Last successfully loaded URL for recovery */
  private lastSuccessfulUrl: string = "";
  /** Recovery count for reporting */
  private recoveryCount = 0;
  /** Discovery metrics */
  private discoveryMetrics: DiscoveryMetrics = {
    extractedLinks: 0,
    clickedLinks: 0,
    uniquePages: 0,
    deadLinks: [],
    spaIssues: [],
  };
  /** Current page being crawled (for source tracking) */
  private currentEntry: QueueEntry | null = null;
  /** Deterministic RNG for reproducible action selection. */
  private rng: Rng;
  /** Fault injection rules compiled once at construction time. */
  private compiledFaultRules: Array<{
    rule: FaultRule;
    pattern: RegExp;
    methods?: string[];
    matched: number;
    injected: number;
  }> = [];

  constructor(options: CrawlerOptions, events: CrawlerEvents = {}) {
    validateOptions(options);

    // Filter out undefined values to preserve defaults
    const filteredOptions = Object.fromEntries(
      Object.entries(options).filter(([_, v]) => v !== undefined)
    );
    this.options = { ...DEFAULT_OPTIONS, ...filteredOptions } as Required<CrawlerOptions>;
    this.actionWeights = { ...DEFAULT_ACTION_WEIGHTS, ...options.actionWeights };
    this.events = events;
    this.baseOrigin = new URL(options.baseUrl).origin;
    this.rng = createRng(options.seed ?? randomSeed());
    this.options.seed = this.rng.seed;
    this.compiledFaultRules = compileFaultRules(options.faultInjection);

    // Initialize logger
    if (options.logFile) {
      this.logger = new Logger({
        logFile: options.logFile,
        level: options.logLevel || "info",
        console: options.logToConsole || false,
        jsonFormat: true,
      });
    } else {
      this.logger = createNullLogger();
    }
  }

  /** Seed used for this run (useful for reproducing failures). */
  getSeed(): number {
    return this.rng.seed;
  }

  /**
   * Match drained rejections against already-captured `pageerror` entries and
   * reclassify them as unhandled-rejection. Rejections in Chromium fire both
   * the DOM event and Playwright's CDP-level pageerror, so we dedupe here.
   */
  private reclassifyRejections(
    errors: PageError[],
    rejections: Array<{ message: string; stack?: string }>,
    url: string
  ): void {
    for (const rejection of rejections) {
      if (this.shouldIgnoreError(rejection.message)) continue;
      const existing = errors.find(
        (e) => e.type === "exception" && e.message === rejection.message
      );
      if (existing) {
        existing.type = "unhandled-rejection";
        continue;
      }
      const error: PageError = {
        type: "unhandled-rejection",
        message: rejection.message,
        stack: rejection.stack,
        url,
        timestamp: Date.now(),
      };
      errors.push(error);
      this.events.onError?.(error);
      this.logger.logPageError(error);
    }
  }

  /**
   * Evaluate all invariants declared for the given phase on the current page.
   * Any invariant that returns false/throws/returns a string is recorded as
   * a PageError with type "invariant-violation".
   */
  private async runInvariants(
    phase: "afterLoad" | "afterActions",
    page: Page,
    url: string,
    errors: PageError[]
  ): Promise<void> {
    const invariants = this.options.invariants || [];
    for (const inv of invariants) {
      const when = inv.when ?? "afterActions";
      if (when !== phase) continue;
      if (inv.urlPattern) {
        const re = toRegExp(inv.urlPattern);
        if (re && !re.test(url)) continue;
        if (!re) continue; // Invalid pattern — silently skip (already flagged by validateOptions).
      }

      let failureReason: string | null = null;
      try {
        const result = await inv.check({ page, url, errors });
        if (result === false) {
          failureReason = `invariant "${inv.name}" returned false`;
        } else if (typeof result === "string") {
          failureReason = result;
        }
      } catch (err) {
        failureReason = err instanceof Error ? err.message : String(err);
      }

      if (failureReason !== null) {
        const error: PageError = {
          type: "invariant-violation",
          message: `[${inv.name}] ${failureReason}`,
          invariantName: inv.name,
          url,
          timestamp: Date.now(),
        };
        errors.push(error);
        this.events.onError?.(error);
        this.logger.logPageError(error);
      }
    }
  }

  /** Pop and return any unhandled promise rejections captured since last call. */
  private async drainRejections(page: Page): Promise<Array<{ message: string; stack?: string }>> {
    try {
      return await page.evaluate(() => {
        // @ts-ignore
        const bag = (window.__chaosRejections || []) as Array<{ message: string; stack?: string }>;
        // @ts-ignore
        window.__chaosRejections = [];
        return bag;
      });
    } catch {
      // Page may have navigated away; drop rejections rather than throwing.
      return [];
    }
  }

  /** Get the logger instance for external use */
  getLogger(): Logger {
    return this.logger;
  }

  /** Record an action for the current page's recovery dump. */
  private addToHistory(action: ActionResult): void {
    this.currentPageActions.push(action);
    if (this.currentPageActions.length > this.options.recoveryHistorySize) {
      this.currentPageActions.shift();
    }
  }

  /** Actions performed on the current page (for recovery diagnostics). */
  getRecentActions(): ActionResult[] {
    return [...this.currentPageActions];
  }

  /** Create recovery info from current state */
  private createRecoveryInfo(failedUrl: string, error: string): RecoveryInfo {
    return {
      failedUrl,
      error,
      recoveredTo: this.lastSuccessfulUrl,
      recentActions: this.getRecentActions(),
      timestamp: Date.now(),
    };
  }

  async start(): Promise<CrawlReport> {
    this.startTime = Date.now();
    this.visited.clear();
    this.queue = [{
      url: normalizeUrl(this.options.baseUrl),
      sourceUrl: "",
      method: "initial",
    }];
    this.results = [];
    this.actions = [];
    this.blockedExternalCount = 0;

    // Reset recovery state
    this.currentPageActions = [];
    this.lastSuccessfulUrl = this.options.baseUrl;
    this.recoveryCount = 0;

    // Reset discovery metrics
    this.discoveryMetrics = {
      extractedLinks: 0,
      clickedLinks: 0,
      uniquePages: 0,
      deadLinks: [],
      spaIssues: [],
    };

    // Log crawl start
    this.logger.logCrawlStart(this.options.baseUrl, {
      maxPages: this.options.maxPages,
      maxActionsPerPage: this.options.maxActionsPerPage,
      timeout: this.options.timeout,
      blockExternalNavigation: this.options.blockExternalNavigation,
      enableRecovery: this.options.enableRecovery,
    });

    if (this.options.screenshots && !existsSync(this.options.screenshotDir)) {
      mkdirSync(this.options.screenshotDir, { recursive: true });
    }

    this.browser = await chromium.launch({ headless: this.options.headless });
    this.context = await this.browser.newContext({
      viewport: this.options.viewport,
      userAgent: this.options.userAgent || undefined,
      // Record mode: ask Playwright to capture all network into the HAR.
      recordHar: this.options.har?.mode === "record" ? { path: this.options.har.path } : undefined,
      // Preloaded cookies + localStorage for auth'd crawls. Playwright parses
      // and validates the file; we don't touch it.
      storageState: this.options.storageState || undefined,
    });

    // Replay mode: serve every matching request from the HAR before it hits
    // the network. Fault injection (installed per-page) still wins because
    // page.route runs before context.route in Playwright.
    if (this.options.har?.mode === "replay") {
      await this.context.routeFromHAR(this.options.har.path, {
        notFound: this.options.har.notFound ?? "fallback",
      });
    }

    try {
      while (this.queue.length > 0 && this.visited.size < this.options.maxPages) {
        const entry = this.queue.shift()!;
        if (this.visited.has(entry.url)) continue;
        if (this.shouldExclude(entry.url)) {
          this.logger.debug("page_excluded", { url: entry.url });
          continue;
        }

        this.visited.add(entry.url);
        this.currentEntry = entry;
        this.discoveryMetrics.uniquePages++;
        this.events.onProgress?.(this.visited.size, this.options.maxPages);
        this.logger.logProgress(this.visited.size, this.options.maxPages);

        const result = await this.crawlPage(entry);
        this.results.push(result);

        // Add discovered links to queue with source tracking
        for (const rawLink of result.links) {
          const link = normalizeUrl(rawLink);
          const alreadyQueued = this.queue.some((e) => e.url === link);
          if (!this.visited.has(link) && !alreadyQueued) {
            this.queue.push({
              url: link,
              sourceUrl: entry.url,
              method: "extracted",
            });
            this.discoveryMetrics.extractedLinks++;
          }
        }
      }
    } finally {
      // Close the context explicitly so the HAR file (record mode) is flushed
      // before `browser.close()` tears everything down.
      await this.context?.close();
      await this.browser.close();
    }

    const endTime = Date.now();
    const report = this.generateReport(endTime);

    // Log crawl end
    this.logger.logCrawlEnd({
      duration: report.duration,
      pagesVisited: report.pagesVisited,
      totalErrors: report.totalErrors,
      blockedExternalNavigations: report.blockedExternalNavigations,
      recoveryCount: this.recoveryCount,
    });

    // Close logger
    await this.logger.close();

    return report;
  }

  /**
   * Run chaos testing on a single page (for Playwright Test integration)
   */
  async testPage(page: Page, url: string): Promise<PageResult> {
    this.startTime = Date.now();
    this.baseOrigin = new URL(url).origin;

    // Set up external navigation blocking and/or fault injection routing.
    if (this.options.blockExternalNavigation || this.compiledFaultRules.length > 0) {
      await this.setupNavigationBlocking(page);
    }

    const result = await this.crawlPageWithExistingPage(page, url);
    this.events.onPageComplete?.(result);
    this.logger.logPageComplete(result);
    this.results.push(result);

    return result;
  }

  private shouldExclude(url: string): boolean {
    return matchesAnyPattern(url, this.options.excludePatterns);
  }

  /** Check if URL matches SPA patterns */
  private matchesSpaPattern(url: string): string | null {
    return matchesSpaPatternPure(url, this.options.spaPatterns);
  }

  private shouldIgnoreError(message: string): boolean {
    return matchesAnyPattern(message, this.options.ignoreErrorPatterns, "i");
  }

  private isExternalUrl(url: string): boolean {
    return isExternalUrlPure(url, this.baseOrigin);
  }

  private async setupNavigationBlocking(page: Page): Promise<void> {
    const blockExternal = this.options.blockExternalNavigation;
    const rules = this.compiledFaultRules;

    // Install a single route handler that first considers fault injection,
    // then falls back to external-navigation blocking, then continues.
    await page.route("**/*", async (route: Route) => {
      const request = route.request();
      const url = request.url();
      const method = request.method().toUpperCase();

      // 1. Fault injection has priority so tests can exercise backends that
      // would otherwise be allowed through.
      for (const compiled of rules) {
        if (!compiled.pattern.test(url)) continue;
        if (compiled.methods && !compiled.methods.includes(method)) continue;

        compiled.matched++;
        const prob = compiled.rule.probability ?? 1;
        // prob 0 should never inject; prob 1 always injects; in between we
        // use the crawler's seeded RNG so probability is reproducible.
        if (prob < 1 && this.rng.next() >= prob) continue;

        compiled.injected++;
        await applyFault(route, compiled.rule.fault);
        return;
      }

      // 2. Block external navigation if requested.
      if (blockExternal && this.isExternalUrl(url)) {
        if (request.isNavigationRequest()) {
          this.blockedExternalCount++;
          this.events.onBlockedNavigation?.(url);
          this.logger.logBlockedNavigation(url);
          await route.abort("blockedbyclient");
          return;
        }
        // Allow non-navigation external requests (images, scripts, etc.)
      }

      // route.fallback() (not continue) so context-level routes — notably
      // routeFromHAR for replay — still get a chance to serve this request.
      await route.fallback();
    });
  }

  private async crawlPage(entry: QueueEntry): Promise<PageResult> {
    const page = await this.context!.newPage();
    const { url, sourceUrl, method, sourceElement } = entry;

    // Scope recovery diagnostics to this page only.
    this.currentPageActions = [];

    if (this.options.blockExternalNavigation || this.compiledFaultRules.length > 0) {
      await this.setupNavigationBlocking(page);
    }

    try {
      const result = await this.crawlPageWithExistingPage(page, url);

      // Add source tracking to result
      result.discoveryMethod = method;
      result.sourceUrl = sourceUrl;
      result.sourceElement = sourceElement;

      // Handle recovery from 404 or error status
      if (
        this.options.enableRecovery &&
        result.statusCode &&
        (result.statusCode === 404 || result.statusCode >= 500)
      ) {
        // Track dead link with source information
        this.discoveryMetrics.deadLinks.push({
          url,
          statusCode: result.statusCode,
          sourceUrl,
          sourceElement,
          method,
        });

        const recovery = this.createRecoveryInfo(
          url,
          `HTTP ${result.statusCode}`
        );
        this.logger.logRecovery(recovery);
        this.logger.logNavigationError(url, result.statusCode, `HTTP ${result.statusCode}`);
        this.recoveryCount++;

        // Try to recover by going back to last successful URL
        if (this.lastSuccessfulUrl && this.lastSuccessfulUrl !== url) {
          try {
            await page.goto(this.lastSuccessfulUrl, {
              timeout: this.options.timeout,
              waitUntil: "networkidle",
            });
            this.logger.info("recovery_success", { recoveredTo: this.lastSuccessfulUrl });
          } catch {
            // Recovery navigation failed, just continue
            this.logger.warn("recovery_failed", { url: this.lastSuccessfulUrl });
          }
        }

        // Mark result as recovered
        result.recovery = recovery;
        result.status = "recovered";
      } else if (result.status === "success" && result.statusCode === 200) {
        // Update last successful URL
        this.lastSuccessfulUrl = url;
      }

      this.events.onPageComplete?.(result);
      this.logger.logPageComplete(result);
      return result;
    } finally {
      await page.close();
    }
  }

  private async crawlPageWithExistingPage(page: Page, url: string): Promise<PageResult> {
    const errors: PageError[] = [];
    const warnings: string[] = [];
    const blockedNavigations: string[] = [];
    const startTime = Date.now();
    // Set to false once collection is done so spurious events fired during
    // page.close() (in-flight requests getting cancelled as ERR_ABORTED, etc.)
    // don't pollute the PageResult.
    let collecting = true;

    this.events.onPageStart?.(url);
    this.logger.logPageStart(url);

    // Set up error listeners. Each error records `page.url()` at fire time
    // so that errors triggered after a chaos-action navigation are attributed
    // to the URL actually in the address bar, not the original crawlPage URL.
    page.on("console", (msg) => {
      if (!collecting) return;
      const type = msg.type();
      const text = msg.text();
      if (type === "error") {
        if (this.shouldIgnoreError(text)) return;
        const error: PageError = {
          type: "console",
          message: text,
          url: page.url(),
          timestamp: Date.now(),
        };
        errors.push(error);
        this.events.onError?.(error);
        this.logger.logPageError(error);
      } else if (type === "warning") {
        warnings.push(text);
      }
    });

    // Capture unhandled exceptions
    page.on("pageerror", (err) => {
      if (!collecting) return;
      if (this.shouldIgnoreError(err.message)) return;
      const error: PageError = {
        type: "exception",
        message: err.message,
        stack: err.stack,
        url: page.url(),
        timestamp: Date.now(),
      };
      errors.push(error);
      this.events.onError?.(error);
      this.logger.logPageError(error);
    });

    // Capture unhandled promise rejections. Claim them via preventDefault so
    // they don't also fire as `pageerror` (which we'd misclassify as exception).
    await page.addInitScript(() => {
      // @ts-ignore - custom bag attached to window
      window.__chaosRejections = [];
      window.addEventListener("unhandledrejection", (event) => {
        const message = event.reason?.message || String(event.reason);
        const stack = event.reason?.stack;
        // @ts-ignore
        window.__chaosRejections.push({ message, stack });
        event.preventDefault();
      });
    });

    page.on("requestfailed", (request) => {
      if (!collecting) return;
      const requestUrl = request.url();
      if (this.shouldIgnoreError(requestUrl)) return;

      // Check if this is a SPA-related error
      const spaPattern = this.matchesSpaPattern(requestUrl);
      if (spaPattern) {
        this.discoveryMetrics.spaIssues.push({
          url: requestUrl,
          type: "routing-404",
          message: request.failure()?.errorText || "SPA routing issue",
          matchedPattern: spaPattern,
        });
        this.logger.debug("spa_issue", { url: requestUrl, pattern: spaPattern });
        return; // Don't count as regular error
      }

      const failure = request.failure();
      const error: PageError = {
        type: "network",
        message: `${requestUrl} - ${failure?.errorText || "Unknown error"}`,
        url: page.url(),
        timestamp: Date.now(),
      };
      errors.push(error);
      this.events.onError?.(error);
      this.logger.logPageError(error);
    });

    // Track blocked external navigations
    const originalBlockedCount = this.blockedExternalCount;

    let result: PageResult;

    try {
      const response = await page.goto(url, {
        timeout: this.options.timeout,
        waitUntil: "networkidle",
      });

      // Drain any unhandled rejections captured during load.
      this.reclassifyRejections(errors, await this.drainRejections(page), url);

      await this.runInvariants("afterLoad", page, url, errors);

      const loadTime = Date.now() - startTime;
      const metrics = await this.collectMetrics(page);
      const links = await this.extractLinks(page);

      // Perform random actions with accessibility-based weighting
      await this.performWeightedActions(page, url);

      // Drain any rejections that fired during actions.
      this.reclassifyRejections(errors, await this.drainRejections(page), url);

      await this.runInvariants("afterActions", page, url, errors);

      let screenshot: string | undefined;
      if (this.options.screenshots) {
        const filename = this.getScreenshotFilename(url);
        await page.screenshot({ path: filename, fullPage: true });
        screenshot = filename;
      }

      result = {
        url,
        status: "success",
        statusCode: response?.status(),
        loadTime,
        errors,
        hasErrors: errors.length > 0,
        warnings,
        metrics,
        links,
        screenshot,
        blockedNavigations:
          this.blockedExternalCount > originalBlockedCount ? blockedNavigations : undefined,
      };
    } catch (err) {
      const loadTime = Date.now() - startTime;
      const isTimeout = err instanceof Error && err.message.includes("Timeout");

      const combinedErrors: PageError[] = [
        ...errors,
        {
          type: "exception",
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          url,
          timestamp: Date.now(),
        },
      ];
      result = {
        url,
        status: isTimeout ? "timeout" : "error",
        loadTime,
        errors: combinedErrors,
        hasErrors: combinedErrors.length > 0,
        warnings,
        links: [],
      };
    }

    // Stop collecting before the caller closes the page — any ERR_ABORTED
    // for in-flight requests cancelled by close() would otherwise be logged
    // against this result.
    collecting = false;

    // onPageComplete fires from the caller (crawlPage / testPage) after any
    // recovery reclassification so the callback sees the final status.
    return result;
  }

  private async collectMetrics(page: Page): Promise<PerformanceMetrics> {
    try {
      const metrics = await page.evaluate(() => {
        const perf = performance;
        const navigation = perf.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
        const paint = perf.getEntriesByType("paint");

        const fcp = paint.find((e) => e.name === "first-contentful-paint");

        return {
          ttfb: navigation?.responseStart - navigation?.requestStart,
          domContentLoaded: navigation?.domContentLoadedEventEnd - navigation?.startTime,
          load: navigation?.loadEventEnd - navigation?.startTime,
          fcp: fcp?.startTime,
        };
      });

      return metrics;
    } catch {
      return {};
    }
  }

  private async extractLinks(page: Page): Promise<string[]> {
    try {
      const links = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("a[href]"))
          .map((a) => (a as HTMLAnchorElement).href)
          .filter((href) => href && !href.startsWith("javascript:") && !href.startsWith("mailto:"));
      });

      // Filter to same-origin links only
      return links.filter((link) => !this.isExternalUrl(link));
    } catch {
      return [];
    }
  }

  /**
   * Get action targets from DOM with accessibility-based weighting
   */
  private async getWeightedActionTargets(page: Page): Promise<ActionTarget[]> {
    const targets: ActionTarget[] = [];

    try {
      // Collect interactive elements from DOM with ARIA info
      const domTargets = await page.evaluate(() => {
        const results: Array<{
          tag: string;
          text: string;
          role: string | null;
          ariaLabel: string | null;
          index: number;
          hasVisibleText: boolean;
          isNavLink: boolean;
          href?: string;
          isInMainContent: boolean;
        }> = [];

        // Links with priority for navigation
        document.querySelectorAll("a[href]").forEach((el, i) => {
          const anchor = el as HTMLAnchorElement;
          const text = anchor.innerText?.trim() || "";
          const ariaLabel = anchor.getAttribute("aria-label");
          const role = anchor.getAttribute("role");
          // Navigation links are in nav, header, or have specific roles
          const isNavLink = !!anchor.closest("nav, header, [role='navigation']");
          // Check if link is in main content area
          const isInMainContent = !!anchor.closest("main, article, [role='main'], .content, #content");

          if (text.length < 100 || ariaLabel) {
            results.push({
              tag: "a",
              text: text || ariaLabel || "",
              role,
              ariaLabel,
              index: i,
              hasVisibleText: text.length > 0,
              isNavLink,
              href: anchor.href,
              isInMainContent,
            });
          }
        });

        // Buttons
        document.querySelectorAll("button, [role='button']").forEach((el, i) => {
          const text = (el as HTMLElement).innerText?.trim() || "";
          const ariaLabel = el.getAttribute("aria-label");
          const role = el.getAttribute("role") || "button";
          const isInMainContent = !!el.closest("main, article, [role='main'], .content, #content");

          if (text.length < 100 || ariaLabel) {
            results.push({
              tag: "button",
              text: text || ariaLabel || "",
              role,
              ariaLabel,
              index: i,
              hasVisibleText: text.length > 0,
              isNavLink: false,
              isInMainContent,
            });
          }
        });

        // Interactive ARIA roles
        const ariaSelectors = [
          "[role='menuitem']",
          "[role='tab']",
          "[role='checkbox']",
          "[role='radio']",
          "[role='switch']",
          "[role='slider']",
          "[role='listbox']",
          "[role='option']",
        ];

        document.querySelectorAll(ariaSelectors.join(", ")).forEach((el, i) => {
          const text = (el as HTMLElement).innerText?.trim() || "";
          const ariaLabel = el.getAttribute("aria-label");
          const role = el.getAttribute("role")!;
          const isInMainContent = !!el.closest("main, article, [role='main'], .content, #content");

          results.push({
            tag: el.tagName.toLowerCase(),
            text: text || ariaLabel || "",
            role,
            ariaLabel,
            index: i,
            hasVisibleText: text.length > 0,
            isNavLink: false,
            isInMainContent,
          });
        });

        // Input fields
        document.querySelectorAll("input, textarea, [role='textbox'], [role='searchbox']").forEach((el, i) => {
          const ariaLabel = el.getAttribute("aria-label");
          const placeholder = el.getAttribute("placeholder");
          const role = el.getAttribute("role") || "input";
          const isInMainContent = !!el.closest("main, article, [role='main'], .content, #content");

          results.push({
            tag: "input",
            text: ariaLabel || placeholder || "",
            role,
            ariaLabel,
            index: i,
            hasVisibleText: false,
            isNavLink: false,
            isInMainContent,
          });
        });

        return results.slice(0, 50); // Limit to prevent too many targets
      });

      // Convert to weighted targets
      for (const t of domTargets) {
        let weight = 1;
        let type: ActionTarget["type"] = "interactive";

        if (t.tag === "a") {
          type = "link";
          weight = this.actionWeights.navigationLinks;
          if (t.isNavLink) weight *= 1.5; // Boost navigation links

          // Boost unvisited links significantly
          if (t.href) {
            try {
              const absoluteUrl = normalizeUrl(new URL(t.href, this.baseOrigin).toString());
              const isQueued = this.queue.some((e) => e.url === absoluteUrl);
              if (!this.visited.has(absoluteUrl) && !isQueued) {
                weight *= 3; // Strong boost for unvisited links
              } else if (this.visited.has(absoluteUrl)) {
                weight *= 0.2; // Reduce weight for already visited
              }
            } catch {
              // Invalid URL, keep default weight
            }
          }
        } else if (t.tag === "button" || t.role === "button") {
          type = "button";
          weight = this.actionWeights.buttons;
        } else if (t.tag === "input" || t.role === "textbox" || t.role === "searchbox") {
          type = "input";
          weight = this.actionWeights.inputs;
        } else if (t.role) {
          type = "interactive";
          weight = this.actionWeights.ariaInteractive;
        }

        // Boost elements with visible text
        if (t.hasVisibleText) {
          weight *= this.actionWeights.visibleText;
        }

        // Boost elements in main content area
        if (t.isInMainContent) {
          weight *= 1.5;
        }

        // Build selector
        let selector: string;
        if (t.text && t.text.length > 0 && t.text.length < 50) {
          selector = `${t.tag}:has-text("${this.escapeSelector(t.text)}")`;
        } else if (t.ariaLabel) {
          selector = `${t.tag}[aria-label="${this.escapeSelector(t.ariaLabel)}"]`;
        } else if (t.role) {
          selector = `[role="${t.role}"]:nth-of-type(${t.index + 1})`;
        } else {
          selector = `${t.tag}:nth-of-type(${t.index + 1})`;
        }

        targets.push({
          selector,
          role: t.role || undefined,
          name: t.text || t.ariaLabel || undefined,
          weight,
          type,
          href: t.href,
        });
      }

      // Add scroll as low-weight option
      targets.push({
        selector: "window",
        weight: this.actionWeights.scroll,
        type: "scroll",
      });
    } catch {
      // Fallback to basic scroll
      targets.push({
        selector: "window",
        weight: 1,
        type: "scroll",
      });
    }

    return targets;
  }

  private escapeSelector(text: string): string {
    return escapeSelectorPure(text);
  }

  /**
   * Perform actions based on weighted random selection
   */
  private async performWeightedActions(page: Page, url: string): Promise<void> {
    const targets = await this.getWeightedActionTargets(page);
    this.logger.debug("action_targets", { count: targets.length, url });
    if (targets.length === 0) return;

    let actionsPerformed = 0;
    let attempts = 0;
    const maxAttempts = this.options.maxActionsPerPage * 3; // Allow retries for skipped elements
    this.logger.debug("action_loop_start", { maxActionsPerPage: this.options.maxActionsPerPage, maxAttempts });

    while (actionsPerformed < this.options.maxActionsPerPage && attempts < maxAttempts) {
      attempts++;

      const selectedTarget = weightedPick(targets, (t) => t.weight, this.rng);

      const result = await this.performActionOnTarget(page, selectedTarget, url);

      // Skip null results (element not visible)
      if (result === null) {
        this.logger.debug("action_skipped", { target: selectedTarget.name || selectedTarget.selector, reason: "not visible" });
        continue;
      }

      actionsPerformed++;
      this.actions.push(result);
      this.addToHistory(result);  // Add to recovery history
      this.events.onAction?.(result);
      this.logger.logAction(result);

      // Small delay between actions
      await page.waitForTimeout(100);
    }
  }

  private async performActionOnTarget(
    page: Page,
    target: ActionTarget,
    url: string
  ): Promise<ActionResult | null> {
    const timestamp = Date.now();

    try {
      if (target.type === "scroll") {
        const scrollY = randomInt(this.rng, 1000);
        await page.evaluate((y) => window.scrollTo(0, y), scrollY);
        return {
          type: "scroll",
          target: `scrollY: ${scrollY}`,
          success: true,
          timestamp,
        };
      }

      const element = page.locator(target.selector).first();
      const isVisible = await element.isVisible().catch(() => false);

      // Skip non-visible elements instead of falling back to hover
      if (!isVisible) {
        return null;
      }

      if (target.type === "input") {
        await element.fill("test input", { timeout: 1000 });
        return {
          type: "input",
          target: target.name || target.selector,
          selector: target.selector,
          success: true,
          timestamp,
        };
      }

      // For links, check if it's external before clicking
      if (target.type === "link") {
        const href = target.href || await element.getAttribute("href").catch(() => null);
        if (href && this.isExternalUrl(href)) {
          return {
            type: "click",
            target: target.name || target.selector,
            selector: target.selector,
            success: true,
            blockedExternal: true,
            timestamp,
          };
        }

        // Track link clicks that navigate (only if not already tracked)
        if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
          try {
            const absoluteUrl = normalizeUrl(new URL(href, url).toString());
            const alreadyQueued = this.queue.some((e) => e.url === absoluteUrl);
            if (!this.visited.has(absoluteUrl) && !alreadyQueued) {
              this.queue.push({
                url: absoluteUrl,
                sourceUrl: url,
                method: "clicked",
                sourceElement: target.name || target.selector,
              });
              this.discoveryMetrics.clickedLinks++;
              this.logger.debug("link_discovered_by_click", { href: absoluteUrl, source: url });
            }
          } catch {
            // Invalid URL, skip
          }
        }
      }

      await element.click({ timeout: 1000 });

      // Wait for any navigation to settle
      await page.waitForLoadState("networkidle", { timeout: 2000 }).catch(() => {});

      return {
        type: "click",
        target: target.name || target.selector,
        selector: target.selector,
        success: true,
        timestamp,
      };
    } catch (err) {
      return {
        type: "click",
        target: target.name || target.selector,
        selector: target.selector,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        timestamp,
      };
    }
  }

  private getScreenshotFilename(url: string): string {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname.replace(/\//g, "_").replace(/^_/, "") || "index";
    return join(this.options.screenshotDir, `${pathname}.png`);
  }

  private generateReport(endTime: number): CrawlReport {
    const summary = this.calculateSummary();

    return {
      baseUrl: this.options.baseUrl,
      seed: this.rng.seed,
      reproCommand: this.buildReproCommand(),
      startTime: this.startTime,
      endTime,
      duration: endTime - this.startTime,
      pagesVisited: this.results.length,
      totalErrors: this.results.reduce((sum, r) => sum + r.errors.length, 0),
      totalWarnings: this.results.reduce((sum, r) => sum + r.warnings.length, 0),
      blockedExternalNavigations: this.blockedExternalCount,
      recoveryCount: this.recoveryCount,
      pages: this.results,
      actions: this.actions,
      summary,
      faultInjections: this.compiledFaultRules.length > 0 ? this.getFaultStats() : undefined,
      errorClusters: clusterErrors(this.results.flatMap((r) => r.errors)),
      har: this.options.har,
    };
  }

  /** Build a shell command that reruns this crawl with the same seed / limits. */
  private buildReproCommand(): string {
    const parts: string[] = ["chaosbringer", "--url", shellQuote(this.options.baseUrl)];
    parts.push("--seed", String(this.rng.seed));
    if (this.options.maxPages !== DEFAULT_OPTIONS.maxPages) {
      parts.push("--max-pages", String(this.options.maxPages));
    }
    if (this.options.maxActionsPerPage !== DEFAULT_OPTIONS.maxActionsPerPage) {
      parts.push("--max-actions", String(this.options.maxActionsPerPage));
    }
    for (const p of this.options.excludePatterns ?? []) {
      parts.push("--exclude", shellQuote(p));
    }
    for (const p of this.options.spaPatterns ?? []) {
      parts.push("--spa", shellQuote(p));
    }
    if (this.options.storageState) {
      parts.push("--storage-state", shellQuote(this.options.storageState));
    }
    return parts.join(" ");
  }

  /** Per-rule fault injection stats (for reporting). */
  getFaultStats(): FaultInjectionStats[] {
    return this.compiledFaultRules.map((c) => ({
      rule: c.rule.name ?? c.pattern.toString(),
      matched: c.matched,
      injected: c.injected,
    }));
  }

  private calculateSummary(): CrawlSummary {
    return summarizePages(this.results, this.discoveryMetrics);
  }
}

/**
 * Validate user-supplied options up front so downstream code can assume
 * well-formed inputs. Every error starts with `chaosbringer:` and names
 * the field, so users don't get an anonymous `TypeError: Invalid URL`.
 */
export function validateOptions(options: CrawlerOptions): void {
  // baseUrl — parse and surface a named error.
  try {
    // eslint-disable-next-line no-new
    new URL(options.baseUrl);
  } catch {
    throw new Error(
      `chaosbringer: "baseUrl" must be an absolute URL (got ${JSON.stringify(options.baseUrl)})`
    );
  }

  const requirePositive = (name: string, value: number | undefined, min: number): void => {
    if (value === undefined) return;
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) {
      throw new Error(
        `chaosbringer: "${name}" must be an integer >= ${min} (got ${JSON.stringify(value)})`
      );
    }
  };
  requirePositive("maxPages", options.maxPages, 1);
  requirePositive("maxActionsPerPage", options.maxActionsPerPage, 0);
  requirePositive("timeout", options.timeout, 1);
  requirePositive("recoveryHistorySize", options.recoveryHistorySize, 0);

  if (options.seed !== undefined) {
    if (!Number.isFinite(options.seed) || !Number.isInteger(options.seed) || options.seed < 0) {
      throw new Error(
        `chaosbringer: "seed" must be a non-negative integer (got ${JSON.stringify(options.seed)})`
      );
    }
  }

  const assertRegexString = (label: string, pattern: string | undefined): void => {
    if (pattern === undefined) return;
    try {
      // eslint-disable-next-line no-new
      new RegExp(pattern);
    } catch {
      throw new Error(`chaosbringer: ${label} has invalid regex: ${JSON.stringify(pattern)}`);
    }
  };

  const assertMatcher = (label: string, m: UrlMatcher | undefined): void => {
    if (m === undefined) return;
    if (m instanceof RegExp) return; // Already compiled, always valid.
    assertRegexString(label, m);
  };

  for (const p of options.excludePatterns ?? []) assertRegexString(`excludePatterns entry`, p);
  for (const p of options.ignoreErrorPatterns ?? []) assertRegexString(`ignoreErrorPatterns entry`, p);
  for (const p of options.spaPatterns ?? []) assertRegexString(`spaPatterns entry`, p);

  for (const rule of options.faultInjection ?? []) {
    const label = rule.name ? `faultInjection rule "${rule.name}"` : `faultInjection rule`;
    assertMatcher(`${label} urlPattern`, rule.urlPattern);
    if (rule.probability !== undefined) {
      const p = rule.probability;
      if (!Number.isFinite(p) || p < 0 || p > 1) {
        throw new Error(
          `chaosbringer: ${label} probability must be in [0, 1] (got ${JSON.stringify(p)})`
        );
      }
    }
  }

  for (const inv of options.invariants ?? []) {
    assertMatcher(`invariant "${inv.name}" urlPattern`, inv.urlPattern);
  }

  if (options.har) {
    const { path, mode } = options.har;
    if (typeof path !== "string" || path.length === 0) {
      throw new Error(`chaosbringer: "har.path" must be a non-empty string`);
    }
    if (mode !== "record" && mode !== "replay") {
      throw new Error(
        `chaosbringer: "har.mode" must be "record" or "replay" (got ${JSON.stringify(mode)})`
      );
    }
  }

  if (options.storageState !== undefined) {
    if (typeof options.storageState !== "string" || options.storageState.length === 0) {
      throw new Error(
        `chaosbringer: "storageState" must be a non-empty path string (got ${JSON.stringify(options.storageState)})`
      );
    }
  }
}

/** Shell-quote a value for inclusion in a reproducible CLI invocation. */
function shellQuote(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_\-:/.=?&@%+,]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Coerce a UrlMatcher to RegExp. Returns null if the string is not a valid regex. */
function toRegExp(m: UrlMatcher): RegExp | null {
  if (m instanceof RegExp) return m;
  try {
    return new RegExp(m);
  } catch {
    return null;
  }
}

function compileFaultRules(rules: FaultRule[] | undefined): Array<{
  rule: FaultRule;
  pattern: RegExp;
  methods?: string[];
  matched: number;
  injected: number;
}> {
  if (!rules || rules.length === 0) return [];
  const compiled: Array<{
    rule: FaultRule;
    pattern: RegExp;
    methods?: string[];
    matched: number;
    injected: number;
  }> = [];
  for (const rule of rules) {
    const pattern = toRegExp(rule.urlPattern);
    if (!pattern) {
      // Skip invalid regex silently; validateOptions will have already raised.
      continue;
    }
    compiled.push({
      rule,
      pattern,
      methods: rule.methods?.map((m) => m.toUpperCase()),
      matched: 0,
      injected: 0,
    });
  }
  return compiled;
}

async function applyFault(route: Route, fault: Fault): Promise<void> {
  switch (fault.kind) {
    case "abort":
      await route.abort(fault.errorCode ?? "failed");
      return;
    case "status": {
      // Chromium emits a spurious ERR_ABORTED alongside the response when the
      // body is empty, so synthesise a minimal JSON body by default. Callers
      // can still opt into an empty body by passing `body: ""` explicitly.
      const body =
        fault.body !== undefined ? fault.body : JSON.stringify({ error: fault.status });
      await route.fulfill({
        status: fault.status,
        body,
        contentType: fault.contentType ?? "application/json",
      });
      return;
    }
    case "delay":
      await new Promise((r) => setTimeout(r, fault.ms));
      await route.fallback();
      return;
  }
}
