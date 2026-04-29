/**
 * ChaosCrawler - Playwright-based chaos testing crawler
 */

import type { Browser, BrowserContext, Page, Route } from "playwright";
import { chromium, devices } from "playwright";
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
  NetworkProfile,
} from "./types.js";
import { NETWORK_PROFILES, PERF_BUDGET_KEYS } from "./types.js";
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
import { checkPerformanceBudget } from "./budget.js";
import { networkConditionsFor } from "./network.js";
import { shardOwns } from "./shard.js";
import { fetchSitemapUrls } from "./sitemap.js";
import { shouldSaveArtifacts, writeFailureBundle } from "./failure-artifacts.js";
import {
  TRACE_FORMAT_VERSION,
  actionToTraceEntry,
  groupTrace,
  readTrace,
  writeTrace,
  type TraceAction,
  type TraceEntry,
} from "./trace.js";

// Options that are opt-in with no meaningful default (HAR, storage state,
// perf budget, trace, device/network) are carved out of the Required<>
// type instead of inventing sentinels.
const DEFAULT_OPTIONS: Required<
  Omit<
    CrawlerOptions,
    | "baseUrl"
    | "har"
    | "storageState"
    | "performanceBudget"
    | "traceOut"
    | "traceReplay"
    | "device"
    | "network"
    | "seedFromSitemap"
    | "shardIndex"
    | "shardCount"
    | "failureArtifacts"
  >
> = {
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
  /** How many failure-artifact bundles have been written. Used as a sequence + cap. */
  private failureArtifactCount = 0;
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
  /** JSONL trace entries collected when `traceOut` is set. */
  private trace: TraceEntry[] = [];
  /**
   * Actions to replay on the current page. Non-null only while a replay run
   * is mid-flight; the action dispatcher branches on this to decide between
   * random-weighted and playback.
   */
  private currentReplayActions: TraceAction[] | null = null;
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
  /**
   * Run-scoped key/value bag shared with every invariant via
   * `InvariantContext.state`. Reset on `start()` so reusing a crawler for
   * multiple runs doesn't leak stale state.
   */
  private invariantState: Map<string, unknown> = new Map();

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
        const result = await inv.check({ page, url, errors, state: this.invariantState });
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
    this.trace = [];
    this.blockedExternalCount = 0;
    this.failureArtifactCount = 0;
    this.invariantState = new Map();

    if (this.isRecordingTrace()) {
      this.trace.push({
        kind: "meta",
        v: TRACE_FORMAT_VERSION,
        seed: this.rng.seed,
        baseUrl: this.options.baseUrl,
        startTime: this.startTime,
      });
    }

    if (this.options.seedFromSitemap) {
      await this.seedQueueFromSitemap(this.options.seedFromSitemap);
    }

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
    // Device descriptor overrides viewport / userAgent / device pixel ratio;
    // explicit options in CrawlerOptions still win because they come later.
    const deviceDesc =
      this.options.device && devices[this.options.device]
        ? devices[this.options.device]
        : undefined;
    this.context = await this.browser.newContext({
      ...deviceDesc,
      // Device descriptor's viewport wins when set — device emulation is
      // only meaningful if the viewport matches. Otherwise fall back to
      // the configured default.
      viewport: deviceDesc?.viewport ?? this.options.viewport,
      userAgent: this.options.userAgent || deviceDesc?.userAgent || undefined,
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
      if (this.options.traceReplay) {
        // Replay: iterate every recorded (visit, actions) group. The trace
        // itself defines the scope — applying maxPages here would silently
        // truncate larger traces, so the cap only applies to live crawls.
        const groups = groupTrace(readTrace(this.options.traceReplay));
        for (let i = 0; i < groups.length; i++) {
          const group = groups[i]!;
          if (this.shouldExclude(group.url)) {
            this.logger.debug("page_excluded", { url: group.url });
            continue;
          }
          this.currentEntry = { url: group.url, sourceUrl: "", method: "initial" };
          this.currentReplayActions = group.actions;
          this.discoveryMetrics.uniquePages++;
          this.events.onProgress?.(i + 1, groups.length);
          this.logger.logProgress(i + 1, groups.length);
          if (this.isRecordingTrace()) {
            this.trace.push({ kind: "visit", url: group.url });
          }
          try {
            const result = await this.crawlPage(this.currentEntry);
            this.results.push(result);
          } finally {
            this.currentReplayActions = null;
          }
        }
      } else {
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

          if (this.isRecordingTrace()) {
            this.trace.push({ kind: "visit", url: entry.url });
          }

          const result = await this.crawlPage(entry);
          this.results.push(result);

          // Add discovered links to queue with source tracking
          for (const rawLink of result.links) {
            const link = normalizeUrl(rawLink);
            const alreadyQueued = this.queue.some((e) => e.url === link);
            if (!this.visited.has(link) && !alreadyQueued && this.ownsUrl(link)) {
              this.queue.push({
                url: link,
                sourceUrl: entry.url,
                method: "extracted",
              });
              this.discoveryMetrics.extractedLinks++;
            }
          }
        }
      }
    } finally {
      // Close the context explicitly so the HAR file (record mode) is flushed
      // before `browser.close()` tears everything down.
      await this.context?.close();
      await this.browser.close();
      if (this.options.traceOut && this.trace.length > 0) {
        writeTrace(this.options.traceOut, this.trace);
      }
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

  /**
   * Shard ownership gate. Returns true when this shard should enqueue `url`.
   * Single-shard configs always return true. Multi-shard configs drop every
   * URL whose hash doesn't match this shard's index — except `baseUrl`, which
   * every shard must process so it has a seed for BFS.
   */
  /**
   * True when trace entries should be recorded in memory. `traceOut`
   * obviously needs them; `failureArtifacts` also needs an in-memory trace
   * so it can serialize the prefix-up-to-failure into each bundle — but
   * only when `saveTrace` isn't explicitly disabled. Recording for a
   * caller that has opted out wastes memory on long crawls.
   */
  private isRecordingTrace(): boolean {
    if (this.options.traceOut) return true;
    const fa = this.options.failureArtifacts;
    if (fa && fa.saveTrace !== false) return true;
    return false;
  }

  /**
   * If failure artefacts are enabled and the page result qualifies, capture
   * a screenshot + HTML + trace snapshot and dump a bundle directory.
   * Errors here are intentionally swallowed: the bundle is diagnostic, not
   * load-bearing — losing one bundle shouldn't take the crawler down.
   */
  private async maybeWriteFailureBundle(page: Page, result: PageResult): Promise<void> {
    const opts = this.options.failureArtifacts;
    if (!opts) return;
    if (!shouldSaveArtifacts(result)) return;
    if (
      typeof opts.maxArtifacts === "number" &&
      this.failureArtifactCount >= opts.maxArtifacts
    ) {
      return;
    }

    const sequence = this.failureArtifactCount;
    this.failureArtifactCount++;

    let screenshot: Buffer | undefined;
    if ((opts.saveScreenshot ?? true)) {
      try {
        screenshot = await page.screenshot({ fullPage: true, type: "png" });
      } catch (err) {
        this.logger.warn("failure_artifact_screenshot_failed", {
          url: result.url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    let html: string | undefined;
    if ((opts.saveHtml ?? true)) {
      try {
        html = await page.content();
      } catch (err) {
        this.logger.warn("failure_artifact_html_failed", {
          url: result.url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    try {
      const bundleDir = writeFailureBundle({
        options: opts,
        baseUrl: this.options.baseUrl,
        seed: this.rng.seed,
        sequence,
        result,
        screenshot,
        html,
        trace: (opts.saveTrace ?? true) ? this.trace : undefined,
      });
      this.logger.info("failure_artifact_written", { url: result.url, bundleDir });
    } catch (err) {
      this.logger.warn("failure_artifact_write_failed", {
        url: result.url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private ownsUrl(url: string): boolean {
    const count = this.options.shardCount;
    if (count === undefined || count <= 1) return true;
    if (url === normalizeUrl(this.options.baseUrl)) return true;
    return shardOwns(url, this.options.shardIndex ?? 0, count);
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

  /**
   * Pull URLs out of a sitemap (index-aware) and prepend them to the queue.
   * URLs outside the baseUrl origin are dropped — the crawler's
   * blockExternalNavigation would block them anyway, and queueing them
   * wastes visit budget.
   */
  private async seedQueueFromSitemap(source: string): Promise<void> {
    let urls: string[];
    try {
      urls = await fetchSitemapUrls(source);
    } catch (err) {
      this.logger.warn("sitemap_fetch_failed", {
        source,
        reason: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const baseOrigin = this.baseOrigin;
    const queuedUrls = new Set(this.queue.map((q) => q.url));
    let added = 0;
    let skippedExternal = 0;
    for (const raw of urls) {
      let normalized: string;
      try {
        normalized = normalizeUrl(new URL(raw, this.options.baseUrl).toString());
      } catch {
        continue;
      }
      try {
        if (new URL(normalized).origin !== baseOrigin) {
          skippedExternal++;
          continue;
        }
      } catch {
        continue;
      }
      if (queuedUrls.has(normalized)) continue;
      if (!this.ownsUrl(normalized)) continue;
      queuedUrls.add(normalized);
      this.queue.push({ url: normalized, sourceUrl: source, method: "extracted" });
      added++;
    }
    this.logger.info("sitemap_seeded", { source, added, skippedExternal, total: urls.length });
  }

  /**
   * Attach a CDP session to the page and apply a throttling preset. Called
   * per-page because `Network.emulateNetworkConditions` is a Page-level
   * setting in Playwright — there's no context-wide equivalent.
   */
  private async applyNetworkProfile(page: Page, profile: NetworkProfile): Promise<void> {
    try {
      const client = await this.context!.newCDPSession(page);
      await client.send("Network.enable");
      await client.send("Network.emulateNetworkConditions", networkConditionsFor(profile));
    } catch (err) {
      this.logger.warn("network_profile_failed", {
        profile,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
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

    if (this.options.network) {
      await this.applyNetworkProfile(page, this.options.network);
    }

    if (this.options.blockExternalNavigation || this.compiledFaultRules.length > 0) {
      await this.setupNavigationBlocking(page);
    }

    try {
      const result = await this.crawlPageWithExistingPage(page, url);

      // Add source tracking to result
      result.discoveryMethod = method;
      result.sourceUrl = sourceUrl;
      result.sourceElement = sourceElement;

      // Capture failure artefacts BEFORE the recovery branch navigates the
      // page away — otherwise the screenshot would show the recovered URL
      // rather than the failing one.
      await this.maybeWriteFailureBundle(page, result);

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
      this.enforcePerformanceBudget(metrics, url, errors);
      const links = await this.extractLinks(page);

      // Replay mode bypasses the weighted random driver — playback owns
      // exactly what runs and in what order.
      if (this.currentReplayActions) {
        await this.performReplayActions(page, url, this.currentReplayActions);
      } else {
        await this.performWeightedActions(page, url);
      }

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

  /**
   * Compare measured metrics against the configured budget and push one
   * invariant-violation per breached metric. Delegates to a pure helper
   * (`checkPerformanceBudget`) so the check is unit-testable without a
   * running browser.
   */
  private enforcePerformanceBudget(
    metrics: PerformanceMetrics,
    url: string,
    errors: PageError[]
  ): void {
    const violations = checkPerformanceBudget(metrics, this.options.performanceBudget, url);
    for (const error of violations) {
      errors.push(error);
      this.events.onError?.(error);
      this.logger.logPageError(error);
    }
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
        const out = new Set<string>();
        const pushResolved = (raw: string | null | undefined) => {
          if (!raw) return;
          const trimmed = raw.trim();
          if (!trimmed) return;
          if (
            trimmed.startsWith("javascript:") ||
            trimmed.startsWith("mailto:") ||
            trimmed.startsWith("tel:")
          ) {
            return;
          }
          try {
            const absolute = new URL(trimmed, document.baseURI).toString();
            out.add(absolute);
          } catch {
            // Malformed URL — skip.
          }
        };

        // <a href> — primary navigation
        for (const a of Array.from(document.querySelectorAll("a[href]"))) {
          pushResolved(a.getAttribute("href"));
        }
        // <area href> — image map regions
        for (const area of Array.from(document.querySelectorAll("area[href]"))) {
          pushResolved(area.getAttribute("href"));
        }
        // <iframe src> — embedded pages
        for (const iframe of Array.from(document.querySelectorAll("iframe[src]"))) {
          pushResolved(iframe.getAttribute("src"));
        }
        // <link rel="canonical"> / rel="alternate" — SEO-level navigation
        for (const link of Array.from(
          document.querySelectorAll(
            'link[rel~="canonical"][href], link[rel~="alternate"][href]'
          )
        )) {
          pushResolved(link.getAttribute("href"));
        }
        // <meta http-equiv="refresh" content="N; url=..."> — meta redirect
        for (const meta of Array.from(
          document.querySelectorAll('meta[http-equiv]')
        )) {
          const httpEquiv = meta.getAttribute("http-equiv");
          if (!httpEquiv || httpEquiv.toLowerCase() !== "refresh") continue;
          const content = meta.getAttribute("content");
          if (!content) continue;
          const semi = content.indexOf(";");
          if (semi === -1) continue;
          const rest = content.slice(semi + 1).trim();
          const m = rest.match(/^url\s*=\s*(.*)$/i);
          if (!m) continue;
          let url = m[1]!.trim();
          if (url.length === 0) continue;
          if (url.startsWith('"') || url.startsWith("'")) {
            const quote = url[0]!;
            const end = url.indexOf(quote, 1);
            if (end === -1) continue;
            url = url.slice(1, end);
          } else {
            // Terminate at the next parameter separator — `0;url=/a;foo=bar`
            // must queue `/a`, not `/a;foo=bar`.
            const sep = url.indexOf(";");
            if (sep !== -1) url = url.slice(0, sep).trim();
          }
          pushResolved(url);
        }

        return Array.from(out);
      });

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
      if (this.isRecordingTrace()) {
        this.trace.push(actionToTraceEntry(result, url));
      }
      this.events.onAction?.(result);
      this.logger.logAction(result);

      // Small delay between actions
      await page.waitForTimeout(100);
    }
  }

  /**
   * Play back a sequence of recorded actions on the current page. Actions
   * whose selectors no longer resolve are recorded as failed — the run
   * continues so downstream errors can still surface. Scroll actions
   * reconstruct the Y offset from the recorded `target` string.
   */
  private async performReplayActions(
    page: Page,
    url: string,
    actions: readonly TraceAction[]
  ): Promise<void> {
    for (const action of actions) {
      const timestamp = Date.now();
      let result: ActionResult;
      try {
        if (action.blockedExternal) {
          // The original run detected an external link and did not click it.
          // Faithfully reproduce that non-action — clicking would introduce
          // behavior the source trace never performed.
          result = {
            type: action.type,
            target: action.target,
            selector: action.selector,
            success: true,
            blockedExternal: true,
            timestamp,
          };
        } else if (action.type === "scroll") {
          const m = /scrollY:\s*(\d+)/i.exec(action.target ?? "");
          const y = m ? Number(m[1]) : 0;
          await page.evaluate((yy) => window.scrollTo(0, yy), y);
          result = { type: "scroll", target: `scrollY: ${y}`, success: true, timestamp };
        } else if (!action.selector) {
          result = {
            type: action.type,
            target: action.target,
            success: false,
            error: "replay: entry has no selector",
            timestamp,
          };
        } else {
          const element = page.locator(action.selector).first();
          const visible = await element.isVisible().catch(() => false);
          if (!visible) {
            result = {
              type: action.type,
              target: action.target,
              selector: action.selector,
              success: false,
              error: "replay: element not visible",
              timestamp,
            };
          } else if (action.type === "input") {
            await element.fill("test input", { timeout: 1000 });
            result = {
              type: "input",
              target: action.target,
              selector: action.selector,
              success: true,
              timestamp,
            };
          } else {
            await element.click({ timeout: 2000 });
            result = {
              type: "click",
              target: action.target,
              selector: action.selector,
              success: true,
              timestamp,
            };
          }
        }
      } catch (err) {
        result = {
          type: action.type,
          target: action.target,
          selector: action.selector,
          success: false,
          error: err instanceof Error ? err.message : String(err),
          timestamp,
        };
      }
      this.actions.push(result);
      this.addToHistory(result);
      if (this.isRecordingTrace()) {
        this.trace.push(actionToTraceEntry(result, url));
      }
      this.events.onAction?.(result);
      this.logger.logAction(result);
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

        // In shard mode, navigating away to a URL owned by another shard
        // would contaminate this page's error counts with cross-shard work
        // and break disjointness. Record the click as a non-action instead
        // of executing it — the owning shard crawls that URL itself.
        if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
          try {
            const absoluteUrl = normalizeUrl(new URL(href, url).toString());
            if (!this.ownsUrl(absoluteUrl)) {
              return {
                type: "click",
                target: target.name || target.selector,
                selector: target.selector,
                success: true,
                shardSkipped: true,
                timestamp,
              };
            }
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
    if (this.options.performanceBudget) {
      const budget = this.options.performanceBudget;
      const entries = PERF_BUDGET_KEYS.filter((k) => typeof budget[k] === "number")
        .map((k) => `${k}=${budget[k]}`)
        .join(",");
      if (entries.length > 0) parts.push("--budget", entries);
    }
    if (this.options.traceOut) {
      parts.push("--trace-out", shellQuote(this.options.traceOut));
    }
    if (this.options.traceReplay) {
      parts.push("--trace-replay", shellQuote(this.options.traceReplay));
    }
    if (this.options.device) {
      parts.push("--device", shellQuote(this.options.device));
    }
    if (this.options.network) {
      parts.push("--network", shellQuote(this.options.network));
    }
    if (this.options.seedFromSitemap) {
      parts.push("--seed-from-sitemap", shellQuote(this.options.seedFromSitemap));
    }
    if (this.options.shardCount !== undefined && this.options.shardCount > 1) {
      parts.push("--shard", `${this.options.shardIndex ?? 0}/${this.options.shardCount}`);
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

  if (options.shardIndex !== undefined || options.shardCount !== undefined) {
    if (options.shardCount === undefined || options.shardIndex === undefined) {
      throw new Error(
        `chaosbringer: "shardIndex" and "shardCount" must be set together`
      );
    }
    if (
      !Number.isInteger(options.shardCount) ||
      options.shardCount < 1
    ) {
      throw new Error(
        `chaosbringer: "shardCount" must be an integer >= 1 (got ${JSON.stringify(options.shardCount)})`
      );
    }
    if (
      !Number.isInteger(options.shardIndex) ||
      options.shardIndex < 0 ||
      options.shardIndex >= options.shardCount
    ) {
      throw new Error(
        `chaosbringer: "shardIndex" must be an integer in [0, ${options.shardCount}) (got ${JSON.stringify(options.shardIndex)})`
      );
    }
  }

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

  const assertNonEmptyStringOpt = (name: string, v: unknown): void => {
    if (v === undefined) return;
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`chaosbringer: "${name}" must be a non-empty path string (got ${JSON.stringify(v)})`);
    }
  };
  assertNonEmptyStringOpt("traceOut", options.traceOut);
  assertNonEmptyStringOpt("traceReplay", options.traceReplay);
  assertNonEmptyStringOpt("seedFromSitemap", options.seedFromSitemap);

  if (options.device !== undefined) {
    if (typeof options.device !== "string" || options.device.length === 0) {
      throw new Error(
        `chaosbringer: "device" must be a non-empty Playwright device name (got ${JSON.stringify(options.device)})`
      );
    }
    if (!devices[options.device]) {
      throw new Error(
        `chaosbringer: "device" ${JSON.stringify(options.device)} is not a known Playwright device descriptor`
      );
    }
  }

  if (options.network !== undefined) {
    const allowed = new Set<string>(NETWORK_PROFILES);
    if (typeof options.network !== "string" || !allowed.has(options.network)) {
      throw new Error(
        `chaosbringer: "network" must be one of ${NETWORK_PROFILES.join(", ")} (got ${JSON.stringify(options.network)})`
      );
    }
  }

  if (options.failureArtifacts !== undefined) {
    const fa = options.failureArtifacts;
    if (fa === null || typeof fa !== "object" || Array.isArray(fa)) {
      throw new Error(
        `chaosbringer: "failureArtifacts" must be an object with a "dir" string`
      );
    }
    if (typeof fa.dir !== "string" || fa.dir.length === 0) {
      throw new Error(
        `chaosbringer: "failureArtifacts.dir" must be a non-empty string`
      );
    }
    if (
      fa.maxArtifacts !== undefined &&
      (!Number.isInteger(fa.maxArtifacts) || fa.maxArtifacts < 0)
    ) {
      throw new Error(
        `chaosbringer: "failureArtifacts.maxArtifacts" must be a non-negative integer`
      );
    }
  }

  if (options.performanceBudget !== undefined) {
    const budget = options.performanceBudget;
    if (budget === null || typeof budget !== "object" || Array.isArray(budget)) {
      throw new Error(
        `chaosbringer: "performanceBudget" must be an object (got ${JSON.stringify(budget)})`
      );
    }
    const allowed = new Set<string>(PERF_BUDGET_KEYS);
    for (const key of Object.keys(budget)) {
      if (!allowed.has(key)) {
        throw new Error(
          `chaosbringer: "performanceBudget.${key}" is not a known metric (allowed: ${PERF_BUDGET_KEYS.join(", ")})`
        );
      }
      const val = (budget as Record<string, unknown>)[key];
      if (typeof val !== "number" || !Number.isFinite(val) || val <= 0) {
        throw new Error(
          `chaosbringer: "performanceBudget.${key}" must be a positive number of ms (got ${JSON.stringify(val)})`
        );
      }
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
