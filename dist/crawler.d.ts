/**
 * ChaosCrawler - Playwright-based chaos testing crawler
 */
import type { Page } from "playwright";
import type { CrawlerOptions, CrawlerEvents, PageResult, ActionResult, CrawlReport, FaultInjectionStats } from "./types.js";
import { Logger } from "./logger.js";
export declare const COMMON_IGNORE_PATTERNS: string[];
export declare class ChaosCrawler {
    private options;
    private actionWeights;
    private events;
    private logger;
    private browser;
    private context;
    private visited;
    private queue;
    private results;
    private actions;
    private blockedExternalCount;
    private startTime;
    private baseOrigin;
    /** Actions performed on the page currently being crawled. Reset on
     * every new crawlPage call so the recovery dump only reports actions
     * from the page that actually failed. */
    private currentPageActions;
    /** Last successfully loaded URL for recovery */
    private lastSuccessfulUrl;
    /** Recovery count for reporting */
    private recoveryCount;
    /** Discovery metrics */
    private discoveryMetrics;
    /** Current page being crawled (for source tracking) */
    private currentEntry;
    /** JSONL trace entries collected when `traceOut` is set. */
    private trace;
    /**
     * Actions to replay on the current page. Non-null only while a replay run
     * is mid-flight; the action dispatcher branches on this to decide between
     * random-weighted and playback.
     */
    private currentReplayActions;
    /** Deterministic RNG for reproducible action selection. */
    private rng;
    /** Fault injection rules compiled once at construction time. */
    private compiledFaultRules;
    constructor(options: CrawlerOptions, events?: CrawlerEvents);
    /** Seed used for this run (useful for reproducing failures). */
    getSeed(): number;
    /**
     * Match drained rejections against already-captured `pageerror` entries and
     * reclassify them as unhandled-rejection. Rejections in Chromium fire both
     * the DOM event and Playwright's CDP-level pageerror, so we dedupe here.
     */
    private reclassifyRejections;
    /**
     * Evaluate all invariants declared for the given phase on the current page.
     * Any invariant that returns false/throws/returns a string is recorded as
     * a PageError with type "invariant-violation".
     */
    private runInvariants;
    /** Pop and return any unhandled promise rejections captured since last call. */
    private drainRejections;
    /** Get the logger instance for external use */
    getLogger(): Logger;
    /** Record an action for the current page's recovery dump. */
    private addToHistory;
    /** Actions performed on the current page (for recovery diagnostics). */
    getRecentActions(): ActionResult[];
    /** Create recovery info from current state */
    private createRecoveryInfo;
    start(): Promise<CrawlReport>;
    /**
     * Run chaos testing on a single page (for Playwright Test integration)
     */
    testPage(page: Page, url: string): Promise<PageResult>;
    private shouldExclude;
    /**
     * Shard ownership gate. Returns true when this shard should enqueue `url`.
     * Single-shard configs always return true. Multi-shard configs drop every
     * URL whose hash doesn't match this shard's index — except `baseUrl`, which
     * every shard must process so it has a seed for BFS.
     */
    private ownsUrl;
    /** Check if URL matches SPA patterns */
    private matchesSpaPattern;
    private shouldIgnoreError;
    private isExternalUrl;
    /**
     * Pull URLs out of a sitemap (index-aware) and prepend them to the queue.
     * URLs outside the baseUrl origin are dropped — the crawler's
     * blockExternalNavigation would block them anyway, and queueing them
     * wastes visit budget.
     */
    private seedQueueFromSitemap;
    /**
     * Attach a CDP session to the page and apply a throttling preset. Called
     * per-page because `Network.emulateNetworkConditions` is a Page-level
     * setting in Playwright — there's no context-wide equivalent.
     */
    private applyNetworkProfile;
    private setupNavigationBlocking;
    private crawlPage;
    private crawlPageWithExistingPage;
    /**
     * Compare measured metrics against the configured budget and push one
     * invariant-violation per breached metric. Delegates to a pure helper
     * (`checkPerformanceBudget`) so the check is unit-testable without a
     * running browser.
     */
    private enforcePerformanceBudget;
    private collectMetrics;
    private extractLinks;
    /**
     * Get action targets from DOM with accessibility-based weighting
     */
    private getWeightedActionTargets;
    private escapeSelector;
    /**
     * Perform actions based on weighted random selection
     */
    private performWeightedActions;
    /**
     * Play back a sequence of recorded actions on the current page. Actions
     * whose selectors no longer resolve are recorded as failed — the run
     * continues so downstream errors can still surface. Scroll actions
     * reconstruct the Y offset from the recorded `target` string.
     */
    private performReplayActions;
    private performActionOnTarget;
    private getScreenshotFilename;
    private generateReport;
    /** Build a shell command that reruns this crawl with the same seed / limits. */
    private buildReproCommand;
    /** Per-rule fault injection stats (for reporting). */
    getFaultStats(): FaultInjectionStats[];
    private calculateSummary;
}
/**
 * Validate user-supplied options up front so downstream code can assume
 * well-formed inputs. Every error starts with `chaosbringer:` and names
 * the field, so users don't get an anonymous `TypeError: Invalid URL`.
 */
export declare function validateOptions(options: CrawlerOptions): void;
//# sourceMappingURL=crawler.d.ts.map