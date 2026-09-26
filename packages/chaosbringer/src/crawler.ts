/**
 * ChaosCrawler - Playwright-based chaos testing crawler
 */

import type { Browser, BrowserContext, ConsoleMessage, Page, Request, Response, Route } from "playwright";
import { chromium, devices } from "playwright";
import { randomBytes } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  collectorInitScript,
  type SpanHandle,
} from "lightbringer/core";
import { cdpEndpointUrl, selectCdpPage } from "./cdp.js";
import { resolveTerminalBrowserTarget } from "./terminal-browser.js";
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
  FaultInjectionStats,
  Fault,
  LifecycleStage,
  NetworkProfile,
} from "./types.js";
import {
  compileLifecycleFaults,
  executeLifecycleAction,
  lifecycleFaultsAtStage,
  lifecycleMatchesUrl,
  lifecycleStatsFrom,
  PlaywrightLifecycleExecutor,
  type CompiledLifecycleFault,
} from "./lifecycle-faults.js";
import { decideFault } from "./schedule.js";
import {
  applyFault,
  compileFaultRules,
  pickFaultRule,
  toRegExp,
  type CompiledFaultRule,
} from "./fault-router.js";
import { drainRejections, watchUnhandledRejections } from "./rejections.js";
import {
  buildRuntimeFaultsScript,
  compileRuntimeFaults,
  mergeRuntimeStats,
  type CompiledRuntimeFault,
} from "./runtime-faults.js";
import {
  buildIframeFaultsScript,
  compileIframeFaults,
  mergeIframeStats,
  type CompiledIframeFault,
} from "./iframe-faults.js";
import {
  CoverageCollector,
  coverageDelta,
  noveltyMultiplier,
  summarizeCoverage,
  targetKey,
} from "./coverage.js";
import {
  drainSpaNavigations,
  installSpaNavigationHook,
  resolveSpaNavigationUrls,
} from "./spa-navigation.js";
import { collectLoadMetrics } from "./page-metrics.js";
import { Logger, createNullLogger } from "./logger.js";
import {
  matchesAnyPattern,
  matchesSpaPattern as matchesSpaPatternPure,
  isExternalUrl as isExternalUrlPure,
  summarizePages,
  normalizeUrl,
} from "./filters.js";
import { createRng, randomSeed, weightedPick, randomInt, type Rng } from "./random.js";
import { clusterErrors } from "./clusters.js";
import { faultWarnings } from "./firings.js";
import { collectRawLinks, resolvePageLinks } from "./links.js";
import {
  collectRawTargets,
  DEFAULT_FILL_VALUE,
  scrollOnlyTargets,
  weighActionTargets,
  type RawActionTarget,
} from "./action-targets.js";
import { checkPerformanceBudget } from "./budget.js";
import { networkConditionsFor } from "./network.js";
import { shardOwns } from "./shard.js";
import { fetchSitemapUrls } from "./sitemap.js";
import { ServerFaultCollector } from "./server-fault-collector.js";
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
import { AdvisorBudget, StallTracker } from "./advisor/budget.js";
import { consultAdvisor } from "./advisor/consult.js";
import { defaultTriggerPolicy, type TriggerPolicy } from "./advisor/trigger.js";
import { REDACTED_REASONING, type ActionAdvisor, type AdvisorCandidate } from "./advisor/types.js";
import type { AdvisorPick, ReplayFidelity } from "./types.js";
import type {
  Driver,
  DriverCandidate,
  DriverHistoryEntry,
  DriverInvariantViolation,
  DriverOperation,
  DriverPick,
  DriverStep,
  ScreenshotMode,
} from "./drivers/types.js";

import { DEFAULT_ACTION_WEIGHTS, DEFAULT_OPTIONS } from "./defaults.js";
import { parseTraceparent } from "./traceparent.js";
import { validateOptions } from "./validate.js";
import { findFaultRuleShadows } from "./fault-shadow.js";
import { buildReproCommand } from "./repro-command.js";
import { coverageFingerprintOf } from "./coverage.js";
import { pageCdp } from "./page-cdp.js";
import { installNavigationGuard, type NavigationGuard } from "./navigation-guard.js";
import { CrawlPerf } from "./crawl-perf.js";
import { buildCrawlPerfSummary } from "./perf-summary.js";
import { tagServerFaults } from "./perf-faults.js";
import { attemptedActionType } from "./perf-key.js";
import { resolvePerfOptions } from "./perf-options.js";
import { errorMessage } from "./errors.js";
import {
  ACTION_SETTLE_CAP_MS,
  pageSettleEnv,
  resolveSettle,
  settleAdaptive,
  trackPageRequests,
  type RequestTracker,
  type ResolvedSettle,
} from "./settle.js";

/** Structural type-guard for the opaque `driver` option. */
function isDriver(v: unknown): v is Driver {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { name?: unknown }).name === "string" &&
    typeof (v as { selectAction?: unknown }).selectAction === "function"
  );
}

function describeTarget(t: ActionTarget): string {
  const parts: string[] = [];
  if (t.role) parts.push(t.role);
  if (t.name) parts.push(`"${t.name}"`);
  parts.push(`(${t.type})`);
  if (t.href) parts.push(`href=${t.href}`);
  return parts.join(" ");
}

/**
 * The geometry fields a decider is given, flattened off `ActionTarget`.
 *
 * Spread at the call site, rather than assigned field by field: a target
 * with no geometry — the `scroll` target, or any of them when the page
 * refused to be scraped — has to leave the keys *absent* rather than set
 * to `undefined`, because `isObstructed` reads `coveredBy !== undefined`.
 * Shared by both candidate views so that rule is written once.
 */
function toCandidateGeometry(t: ActionTarget) {
  if (!t.geometry) return {};
  return {
    bbox: t.geometry.bbox,
    inViewport: t.geometry.inViewport,
    inert: t.geometry.inert,
    ...(t.geometry.coveredBy === undefined ? {} : { coveredBy: t.geometry.coveredBy }),
  };
}

/**
 * The driver's view of the current targets. `index` is positional into the
 * same array the caller holds, so the two must be rebuilt together — a
 * candidate list that outlives its targets resolves picks against the
 * wrong elements.
 */
function toDriverCandidates(targets: ReadonlyArray<ActionTarget>): DriverCandidate[] {
  return targets.map((t, index) => ({
    index,
    selector: t.selector,
    description: describeTarget(t),
    type: t.type,
    weight: t.weight,
    href: t.href,
    selectValue: t.selectValue,
    ...toCandidateGeometry(t),
  }));
}

/** The picker stamp a trace entry carries: `actionToTraceEntry`'s third parameter. */
type TraceStamp = TraceAction["advisor"];

/**
 * The trace stamp for a driver pick. Only a pick that explained itself is
 * stamped — an unexplained pick reads as a plain action in the trace.
 */
function driverTraceStamp(
  pick: Exclude<DriverPick, { kind: "skip" }>,
  driverName: string,
): TraceStamp {
  if (!pick.reasoning) return undefined;
  const confidence = pick.kind === "select" ? pick.confidence : undefined;
  return {
    provider: pick.source ?? driverName,
    reason: "explicit_request",
    reasoning: pick.reasoning,
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

export class ChaosCrawler {
  private options: Required<CrawlerOptions>;
  private actionWeights: Required<ActionWeights>;
  private events: CrawlerEvents;
  private logger: Logger;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private cdpPage: Page | null = null;
  private readonly initializedPages = new WeakSet<Page>();
  private readonly routeHandlers = new Map<Page, (route: Route) => Promise<void>>();
  /** The CDP navigation guard on the CDP-attach page, disposed at teardown. */
  private readonly navigationGuards = new Map<Page, NavigationGuard>();
  /** Pages that already have the route or the guard, so neither goes on twice. */
  private readonly interceptedPages = new WeakSet<Page>();
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
  private compiledFaultRules: CompiledFaultRule[] = [];
  /**
   * Routes held open by a `hang` fault with no `releaseAfterMs`. Drained
   * (aborted with "timedout") when the page that issued them is torn down,
   * so a hung request can't keep the context from closing. `heldRequests`
   * survives the drain for the report.
   */
  private heldRoutes: Route[] = [];
  private heldRequests = 0;
  /** Page-lifecycle faults compiled once at construction time. */
  private compiledLifecycleFaults: CompiledLifecycleFault[] = [];
  /** Compiled runtime faults — installed once at context level via init script. */
  private compiledRuntimeFaults: CompiledRuntimeFault[] = [];
  /** Compiled iframe faults — installed once at context level via init script. */
  private compiledIframeFaults: CompiledIframeFault[] = [];
  /**
   * Per-page lifecycle executor — created on `applyLifecycleStage` first
   * call for each page and dropped when the page is closed.
   */
  private lifecycleExecutor: PlaywrightLifecycleExecutor | null = null;
  /**
   * Run-scoped key/value bag shared with every invariant via
   * `InvariantContext.state`. Reset on `start()` so reusing a crawler for
   * multiple runs doesn't leak stale state.
   */
  private invariantState: Map<string, unknown> = new Map();
  /** Resolved coverage-feedback config (null when disabled). */
  private coverageFeedback: { enabled: true; boost: number; topN: number } | null = null;
  /** Per-page coverage collector — recreated each new page when enabled. */
  private coverageCollector: CoverageCollector | null = null;
  /** All V8 function fingerprints seen across the run so far. */
  private globalCoverage: Set<string> = new Set();
  /** Per-page coverage delta count, in BFS visit order. */
  private pageCoverageDeltas: Array<{ url: string; addedCount: number }> = [];
  /** Historical novelty score per `targetKey(url, selector)`. */
  private targetNovelty: Map<string, number> = new Map();
  /**
   * Most recent V8 coverage snapshot taken for the current page. Per-action
   * deltas are computed as `take() − lastCoverageSnapshot`. Reset to an
   * empty set whenever a fresh page is opened.
   */
  private lastCoverageSnapshot: Set<string> = new Set();
  /** Resolved advisor wiring (null when the option is unset). */
  private advisorRuntime: {
    provider: ActionAdvisor;
    policy: TriggerPolicy;
    budget: AdvisorBudget;
    stall: StallTracker;
    timeoutMs: number;
    redactReasoning: boolean;
    screenshotFullPage: boolean;
    callsAttempted: number;
    callsSucceeded: number;
    picks: AdvisorPick[];
    /**
     * Selector → suggestion map, populated immediately before
     * `performActionOnTarget` so the just-recorded ActionResult can be
     * stamped onto the matching trace entry. Cleared after every action
     * so a non-advisor action doesn't accidentally pick up stale state.
     */
    pendingPick: { selector: string; reasoning: string; reason: AdvisorPick["reason"] } | null;
  } | null = null;
  /** Per-run replay drift counters. Populated only when `traceReplay` is set. */
  private replayFidelity: ReplayFidelity | null = null;
  /**
   * Buffers server-side fault events parsed from response headers when
   * `options.server.mode === "remote"`. Null otherwise so the per-page
   * `page.on("response")` listener can be skipped in the common case.
   */
  private readonly serverFaultCollector: ServerFaultCollector | null;
  /**
   * Set by the action loop immediately before each `performActionOnTarget`
   * call; cleared at the start of the next iteration. The traceparent
   * injection site uses `recordTraceId` to append captured trace-ids onto
   * this action's `traceIds[]`.
   */
  private currentAction: ActionResult | null = null;
  /** Resolved driver (null when caller did not pass `options.driver`). */
  private readonly driver: Driver | null;
  /** Per-step perf measurement: the current page's session and the crawl's perf state. */
  private readonly perf: CrawlPerf;
  /** Resolved `settle` option: how each load and each action waits. */
  private readonly settle: ResolvedSettle;
  /**
   * The current page's in-flight requests, for adaptive settle. Attached for
   * the page's whole visit, not per step: a request started before a step's
   * settle begins is what that settle has to wait for. Null under
   * `networkidle`, and between pages.
   */
  private pageRequests: RequestTracker | null = null;
  /** Settles of the current page that hit their cap (adaptive only). */
  private pageSettleCapped = 0;
  /**
   * Buffer of invariant violations observed since the driver's previous
   * step. Drained at the top of every driver-loop iteration. Empty when
   * no driver is configured.
   */
  private driverPendingViolations: DriverInvariantViolation[] = [];

  constructor(options: CrawlerOptions, events: CrawlerEvents = {}) {
    validateOptions(options);

    // Filter out undefined values to preserve defaults
    const filteredOptions = Object.fromEntries(
      Object.entries(options).filter(([_, v]) => v !== undefined)
    );
    this.options = { ...DEFAULT_OPTIONS, ...filteredOptions } as Required<CrawlerOptions>;
    this.serverFaultCollector = this.options.server?.mode === "remote"
      ? new ServerFaultCollector(this.options.server.responseHeaderPrefix ?? "x-chaos-fault")
      : null;
    this.actionWeights = { ...DEFAULT_ACTION_WEIGHTS, ...options.actionWeights };
    this.events = events;
    this.baseOrigin = new URL(options.baseUrl).origin;
    this.rng = createRng(options.seed ?? randomSeed());
    this.options.seed = this.rng.seed;
    this.compiledFaultRules = compileFaultRules(options.faultInjection);
    this.compiledLifecycleFaults = compileLifecycleFaults(options.lifecycleFaults);
    this.compiledRuntimeFaults = compileRuntimeFaults(options.runtimeFaults);
    this.compiledIframeFaults = compileIframeFaults(options.iframeFaults);
    if (options.coverageFeedback?.enabled) {
      this.coverageFeedback = {
        enabled: true,
        boost: options.coverageFeedback.boost ?? 2,
        topN: options.coverageFeedback.topN ?? 20,
      };
    }

    this.driver = isDriver(options.driver) ? options.driver : null;
    this.settle = resolveSettle(options.settle);
    // `perfBudgets` needs spans to check, so rules without `perf` turn it on
    // at light level (validateOptions refuses rules with `perf: false`).
    const perfOptions = resolvePerfOptions(
      options.perf ?? (options.perfBudgets && options.perfBudgets.length > 0 ? true : undefined),
    );

    if (options.advisor) {
      const defaults = defaultTriggerPolicy();
      this.advisorRuntime = {
        provider: options.advisor.provider,
        policy: {
          maxCallsPerCrawl: options.advisor.maxCallsPerCrawl ?? defaults.maxCallsPerCrawl,
          maxCallsPerPage: options.advisor.maxCallsPerPage ?? defaults.maxCallsPerPage,
          noveltyStallThreshold:
            options.advisor.noveltyStallThreshold ?? defaults.noveltyStallThreshold,
          consultOnInvariantViolation:
            options.advisor.consultOnInvariantViolation ?? defaults.consultOnInvariantViolation,
          minCandidatesToConsult:
            options.advisor.minCandidatesToConsult ?? defaults.minCandidatesToConsult,
        },
        budget: new AdvisorBudget(),
        stall: new StallTracker(),
        timeoutMs: options.advisor.timeoutMs ?? 8_000,
        redactReasoning: options.advisor.redactReasoning ?? false,
        screenshotFullPage: options.advisor.screenshotMode === "fullPage",
        callsAttempted: 0,
        callsSucceeded: 0,
        picks: [],
        pendingPick: null,
      };
    }

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
    this.perf = new CrawlPerf(perfOptions, this.logger, this.options.perfBudgets);
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
      this.emitPageError(errors, error);
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
        failureReason = errorMessage(err);
      }

      if (failureReason !== null) {
        const error: PageError = {
          type: "invariant-violation",
          message: `[${inv.name}] ${failureReason}`,
          invariantName: inv.name,
          url,
          timestamp: Date.now(),
        };
        this.emitPageError(errors, error);
        this.advisorRuntime?.stall.recordInvariantViolation();
        if (this.driver !== null) {
          this.driverPendingViolations.push({ name: inv.name, message: failureReason });
        }
      }
    }
  }

  /**
   * Drain the History-API navigations recorded since the previous drain and
   * append them to `links`, resolved against the page's current URL. The
   * queue feeder de-dups, so overlap with `extractLinks` is fine.
   */
  private async appendSpaLinks(page: Page, links: string[]): Promise<void> {
    const urls = resolveSpaNavigationUrls(await drainSpaNavigations(page), page.url());
    for (const u of urls) links.push(u);
  }

  /** Pop and return any unhandled promise rejections captured since last call. */
  private async drainRejections(page: Page): Promise<Array<{ message: string; stack?: string }>> {
    return drainRejections(page);
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
    this.globalCoverage = new Set();
    this.pageCoverageDeltas = [];
    this.targetNovelty = new Map();
    this.perf.reset();
    if (this.advisorRuntime) {
      this.advisorRuntime.budget = new AdvisorBudget();
      this.advisorRuntime.stall = new StallTracker();
      this.advisorRuntime.callsAttempted = 0;
      this.advisorRuntime.callsSucceeded = 0;
      this.advisorRuntime.picks = [];
      this.advisorRuntime.pendingPick = null;
    }
    this.replayFidelity = this.options.traceReplay
      ? { totalActions: 0, succeeded: 0, selectorMissing: 0, noSelectorRecorded: 0, threw: 0 }
      : null;

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

    // Surface fault rules whose URL pattern is fully shadowed by an
    // earlier rule (the unreachable-rule case from #129). Rules are
    // evaluated top-to-bottom, first-match-wins, so a broad catch-all
    // placed before a specific override will silently swallow every
    // request the override expected.
    for (const shadow of findFaultRuleShadows(this.compiledFaultRules)) {
      this.logger.warn("fault_rule_shadowed", {
        earlierRule: shadow.earlierName,
        laterRule: shadow.laterName,
        sampleUrl: shadow.sampleUrl,
      });
    }

    if (this.options.screenshots && !existsSync(this.options.screenshotDir)) {
      mkdirSync(this.options.screenshotDir, { recursive: true });
    }

    try {
      if (this.options.cdpEndpoint || this.options.terminalBrowser) {
        const connection = this.options.terminalBrowser
          ? await resolveTerminalBrowserTarget(this.options.baseUrl)
          : { cdpEndpoint: this.options.cdpEndpoint, cdpTargetId: this.options.cdpTargetId };
        this.browser = await chromium.connectOverCDP(cdpEndpointUrl(connection.cdpEndpoint));
        this.cdpPage = await selectCdpPage(this.browser, this.options.baseUrl, connection.cdpTargetId);
        this.context = this.cdpPage.context();
      } else {
        this.browser = await chromium.launch({
          ...this.options.launchOptions,
          headless: this.options.headless,
        });
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
      }

      // lightbringer's in-page collector (web-vitals + long-task observers),
      // which is what `collectLoadMetrics` reads LCP and TBT from. It is installed
      // first, before every other init script, and the order is load-bearing:
      // init scripts run in registration order, and the collector captures the
      // native `performance.now` / `timeOrigin` when it runs. Installed after
      // the runtime-fault script, a `clock-skew` fault would already have
      // replaced the clock it captures.
      //
      // It runs on every crawl, not only under perf measurement. Without perf
      // it starts without the rAF frame probe: a per-frame callback on every
      // page nobody measures is the one steady cost the collector would
      // otherwise add. With perf the probe runs from each document's first
      // frame. Starting it lazily when a span opens is not enough here: the
      // load span opens on the document before `page.goto`, and a click that
      // navigates opens its span on the document it leaves, so the document
      // the span is really about would never start its probe and those spans
      // would carry no frames.
      await (this.cdpPage ?? this.context).addInitScript({
        content: collectorInitScript({ frames: this.perf.enabled }),
      });

      // Runtime fault init script: monkey-patches in-page JS APIs (fetch / Date /
      // …) on every navigation. CDP runs scope it to the selected page.
      if (this.compiledRuntimeFaults.length > 0) {
        const script = buildRuntimeFaultsScript(
          this.compiledRuntimeFaults.map((c) => c.fault),
          this.rng.seed,
        );
        await (this.cdpPage ?? this.context).addInitScript({ content: script });
      }

      // Caller-supplied init scripts, after the fault layers so a script can
      // observe the patched APIs. Installed even when empty-checked away, so a
      // caller that passes `[]` costs nothing.
      for (const script of this.options.initScripts ?? []) {
        await (this.cdpPage ?? this.context).addInitScript({ content: script });
      }

      // Iframe fault init script: monkey-patches HTMLIFrameElement.prototype.src
      // (and setAttribute("src", …)) so faults fire when the host page assigns
      // an iframe's URL. Independent of runtimeFaults so a page can configure
      // either layer on its own.
      if (this.compiledIframeFaults.length > 0) {
        const script = buildIframeFaultsScript(
          this.compiledIframeFaults.map((c) => c.fault),
          this.rng.seed,
        );
        await (this.cdpPage ?? this.context).addInitScript({ content: script });
      }

      // Replay mode: serve every matching request from the HAR before it hits
      // the network. Fault injection (installed per-page) still wins because
      // page.route runs before context.route in Playwright.
      if (this.options.har?.mode === "replay") {
        await this.context.routeFromHAR(this.options.har.path, {
          notFound: this.options.har.notFound ?? "fallback",
        });
      }

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
      if (this.cdpPage) {
        await this.releaseCdpPageInterception(this.cdpPage);
        this.cdpPage = null;
      } else {
        await this.context?.close();
      }
      await this.browser?.close();
      if (this.options.traceOut && this.trace.length > 0) {
        writeTrace(this.options.traceOut, this.trace);
      }
    }

    const endTime = Date.now();
    const report = this.generateReport(endTime);

    // Surface every configured fault that did not take effect — a typo'd
    // urlPattern, a rule shadowed by an earlier catch-all (rules are
    // first-match-wins), or a firing policy that declined. Without this the
    // only signal is a zero buried in the report, which is easy to miss.
    //
    // This walked `compiledFaultRules` and warned only on `matched === 0`
    // until it read from `faultWarnings`: the network layer alone, one of the
    // three diagnoses. See that function for why the other three layers being
    // silent is the same defect the counters themselves were fixed for.
    for (const { event, data } of faultWarnings(report)) {
      this.logger.warn(event, data);
    }

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
    await this.setupPageInterception(page);

    // The page belongs to the caller, so this method never closes it — which
    // is exactly why it has to release what it parked. A `hang` fault holds a
    // route open with no answer; leaving it held past the result means the
    // caller's next action on this page waits on a request nothing will ever
    // answer. The drain is in a `finally` rather than after the result
    // because a page that throws mid-run is exactly the case where the
    // caller is least likely to release it themselves.
    try {
      const result = await this.crawlPageWithExistingPage(page, url);
      this.events.onPageComplete?.(result);
      this.logger.logPageComplete(result);
      this.results.push(result);

      return result;
    } finally {
      await this.drainHeldRoutes();
    }
  }

  /**
   * Release every request currently parked by a `hang` fault, on demand.
   *
   * `testPage()` already does this before it returns, so most callers never
   * need it. It exists for the one shape that owns the page across several
   * operations of its own — apply faults, drive the page directly, then hand
   * it back — where "parked until the crawler is done with it" is not the
   * lifetime the caller has in mind.
   */
  async release(): Promise<void> {
    await this.drainHeldRoutes();
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
  /**
   * Read `window.__chaosbringerRuntimeStats` and accumulate into the
   * compiled runtime-fault counters. Errors are swallowed: the in-page
   * counter is best-effort diagnostics, not load-bearing.
   */
  private async collectRuntimeFaultStats(page: Page): Promise<void> {
    if (this.compiledRuntimeFaults.length === 0) return;
    try {
      const pageStats = (await page.evaluate(
        () =>
          (globalThis as { __chaosbringerRuntimeStats?: Record<string, { matched: number; fired: number }> })
            .__chaosbringerRuntimeStats ?? {},
      )) as Record<string, { matched: number; fired: number }>;
      mergeRuntimeStats(this.compiledRuntimeFaults, pageStats);
    } catch (err) {
      this.logger.warn("runtime_fault_stats_failed", {
        error: errorMessage(err),
      });
    }
  }

  /**
   * Read `window.__chaosbringerIframeFaultStats` and accumulate into the
   * compiled iframe-fault counters. Errors are swallowed: the in-page
   * counter is best-effort diagnostics, not load-bearing.
   */
  private async collectIframeFaultStats(page: Page): Promise<void> {
    if (this.compiledIframeFaults.length === 0) return;
    try {
      const pageStats = (await page.evaluate(
        () =>
          (globalThis as { __chaosbringerIframeFaultStats?: Record<string, { matched: number; fired: number }> })
            .__chaosbringerIframeFaultStats ?? {},
      )) as Record<string, { matched: number; fired: number }>;
      mergeIframeStats(this.compiledIframeFaults, pageStats);
    } catch (err) {
      this.logger.warn("iframe_fault_stats_failed", {
        error: errorMessage(err),
      });
    }
  }

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
          error: errorMessage(err),
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
          error: errorMessage(err),
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
        error: errorMessage(err),
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
        reason: errorMessage(err),
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
   * Take a coverage snapshot right after `page.goto` finishes. Functions
   * executed during page load are credited to the URL itself (no specific
   * action) and folded into `globalCoverage`. The snapshot is also saved as
   * the per-action delta baseline.
   */
  private async recordPageLoadCoverage(url: string): Promise<void> {
    if (this.advisorRuntime) {
      this.advisorRuntime.stall.resetForNewPage();
      this.advisorRuntime.budget.resetPage(url);
    }
    if (!this.coverageCollector) {
      this.lastCoverageSnapshot = new Set();
      return;
    }
    let snapshot: Set<string>;
    try {
      snapshot = await this.coverageCollector.take();
    } catch (err) {
      this.logger.warn("coverage_take_failed", {
        url,
        phase: "page-load",
        reason: errorMessage(err),
      });
      this.lastCoverageSnapshot = new Set();
      return;
    }
    const novel = coverageDelta(this.globalCoverage, snapshot);
    for (const fp of novel) this.globalCoverage.add(fp);
    this.pageCoverageDeltas.push({ url, addedCount: novel.size });
    this.lastCoverageSnapshot = snapshot;
  }

  /**
   * Take a coverage snapshot after a chaos action and credit any
   * never-before-seen functions to `(url, selector)` in `targetNovelty`.
   * Updates `globalCoverage` and `lastCoverageSnapshot` so subsequent
   * actions see the right baseline.
   */
  private async attributeActionCoverage(url: string, selector: string): Promise<void> {
    if (!this.coverageCollector) return;
    let snapshot: Set<string>;
    try {
      snapshot = await this.coverageCollector.take();
    } catch (err) {
      this.logger.warn("coverage_take_failed", {
        url,
        selector,
        phase: "action",
        reason: errorMessage(err),
      });
      return;
    }
    const actionDelta = coverageDelta(this.lastCoverageSnapshot, snapshot);
    if (actionDelta.size === 0) {
      this.lastCoverageSnapshot = snapshot;
      this.advisorRuntime?.stall.recordZeroNovelty();
      return;
    }
    const novel = coverageDelta(this.globalCoverage, actionDelta);
    if (novel.size > 0) {
      const key = targetKey(url, selector);
      this.targetNovelty.set(key, (this.targetNovelty.get(key) ?? 0) + novel.size);
      for (const fp of novel) this.globalCoverage.add(fp);
      this.advisorRuntime?.stall.recordNovelty();
    } else {
      this.advisorRuntime?.stall.recordZeroNovelty();
    }
    this.lastCoverageSnapshot = snapshot;
  }

  /**
   * Compute the coverage-feedback weight multiplier for a target on a given
   * URL. Returns 1 when feedback is off or when the target has no history.
   */
  private coverageWeightFor(url: string, selector: string): number {
    if (!this.coverageFeedback) return 1;
    const score = this.targetNovelty.get(targetKey(url, selector)) ?? 0;
    return noveltyMultiplier(score, this.coverageFeedback.boost);
  }

  /**
   * Append a trace-id to the currently-executing action, if any. Called
   * from the per-request traceparent injection in `setupNavigationBlocking`.
   * During the page load (no action in flight) it goes to the load span.
   */
  private recordTraceId(traceId: string): void {
    if (!this.currentAction) {
      // A request of the page load: the load span keeps it for the
      // server-fault join (no-op unless the load span is open).
      this.perf.noteLoadTraceId(traceId);
      return;
    }
    if (!this.currentAction.traceIds) this.currentAction.traceIds = [];
    this.currentAction.traceIds.push(traceId);
  }

  private async consultAdvisorIfStalled(
    page: Page,
    url: string,
    targets: ReadonlyArray<ActionTarget>,
  ): Promise<ActionTarget | null> {
    const runtime = this.advisorRuntime;
    if (!runtime) return null;

    const candidates: AdvisorCandidate[] = targets.map((t, index) => ({
      index,
      selector: t.selector,
      description: describeTarget(t),
      type: t.type,
      ...toCandidateGeometry(t),
    }));

    const lastActionPerf = this.perf.lastActionPerf();
    const result = await consultAdvisor({
      state: {
        callsThisCrawl: runtime.budget.callsThisCrawl(),
        callsThisPage: runtime.budget.callsThisPage(url),
        consecutiveZeroNovelty: runtime.stall.consecutiveZeroNovelty(),
        pendingInvariantViolation: runtime.stall.invariantViolationPending(),
      },
      policy: runtime.policy,
      budget: runtime.budget,
      provider: runtime.provider,
      url,
      candidates,
      screenshotSupplier: () => page.screenshot({ fullPage: runtime.screenshotFullPage }),
      timeoutMs: runtime.timeoutMs,
      ...(lastActionPerf ? { lastActionPerf } : {}),
    });

    if (result.outcome === "skipped") return null;

    runtime.callsAttempted += 1;

    this.logger.debug("advisor_consult", {
      url,
      reason: result.decision.reason,
      candidateCount: candidates.length,
      outcome: result.outcome,
      durationMs: result.durationMs,
      provider: runtime.provider.name,
    });

    if (!result.suggestion || !result.decision.reason) return null;

    runtime.callsSucceeded += 1;
    runtime.stall.recordAdvisorPick();

    const target = targets[result.suggestion.chosenIndex];
    if (!target) return null;

    const storedReasoning = runtime.redactReasoning ? REDACTED_REASONING : result.suggestion.reasoning;

    runtime.picks.push({
      url,
      reason: result.decision.reason,
      chosenSelector: target.selector,
      reasoning: storedReasoning,
    });
    runtime.pendingPick = {
      selector: target.selector,
      reasoning: storedReasoning,
      reason: result.decision.reason,
    };
    return target;
  }

  /**
   * Pop the just-pending advisor pick if (and only if) it matches the
   * selector that was actually performed. Mismatch can happen when the
   * advisor's chosen target was rejected as not-visible and the loop
   * fell back to a heuristic pick — those should NOT be tagged advisor.
   */
  private consumeAdvisorStamp(selector: string) {
    const runtime = this.advisorRuntime;
    if (!runtime?.pendingPick) return undefined;
    const pending = runtime.pendingPick;
    runtime.pendingPick = null;
    if (pending.selector !== selector) return undefined;
    return {
      provider: runtime.provider.name,
      reason: pending.reason,
      reasoning: pending.reasoning,
    };
  }

  /**
   * Run every lifecycle fault that targets `stage` and matches `url`. Errors
   * are caught and recorded in the fault's stats counter — a misbehaving
   * fault should not abort the rest of the crawl.
   */
  /** Register a route parked by a `hang` fault. */
  private holdRoute(route: Route): void {
    this.heldRoutes.push(route);
    this.heldRequests++;
  }

  /**
   * Abort every parked route. Called when a page the crawler owns is torn
   * down (`crawlPage`) and before `testPage()` hands a caller-owned page
   * back. Safe to call repeatedly, and safe to call late: a caller can close
   * the page while a route is still parked, so aborting a route whose page is
   * already gone is swallowed rather than surfaced as a run failure.
   */
  private async drainHeldRoutes(): Promise<void> {
    if (this.heldRoutes.length === 0) return;
    const held = this.heldRoutes;
    this.heldRoutes = [];
    await Promise.all(
      held.map((route) =>
        route.abort("timedout").catch(() => {
          /* page already gone — the request died with it */
        }),
      ),
    );
  }

  private async applyLifecycleStage(
    stage: LifecycleStage,
    page: Page,
    url: string,
  ): Promise<void> {
    const compiled = lifecycleFaultsAtStage(this.compiledLifecycleFaults, stage);
    if (compiled.length === 0) return;

    if (this.lifecycleExecutor === null) {
      // The page's own context rather than `this.context`: on the
      // `testPage()` path the page belongs to the caller and the crawler
      // never opened a context of its own. The CDP session is the page's
      // shared one, so a CPU throttle does not attach a second session.
      const context = page.context();
      this.lifecycleExecutor = new PlaywrightLifecycleExecutor(page, context, () =>
        pageCdp(page).session(),
      );
    }
    const executor = this.lifecycleExecutor;

    for (const c of compiled) {
      if (!lifecycleMatchesUrl(c, url)) continue;
      const occurrence = c.matched;
      c.matched++;
      if (decideFault(c.fault, occurrence, this.rng) === "pass") continue;
      try {
        await executeLifecycleAction(c.fault.action, executor);
        c.fired++;
        // Persistent: a throttle or wiped storage lasts the rest of the visit.
        // Before the page's perf session opens it is kept for the load span.
        this.perf.noteFault(c.name, { persistent: true });
      } catch (err) {
        c.errored++;
        this.logger.warn("lifecycle_fault_failed", {
          name: c.name,
          stage,
          url,
          reason: errorMessage(err),
        });
      }
    }
  }

  /**
   * Apply a throttling preset through the page's shared CDP session. Called
   * per-page because `Network.emulateNetworkConditions` is a Page-level
   * setting in Playwright — there's no context-wide equivalent.
   */
  private async applyNetworkProfile(page: Page, profile: NetworkProfile): Promise<void> {
    try {
      const cdp = pageCdp(page);
      await cdp.enable("Network");
      const client = await cdp.session();
      await client.send("Network.emulateNetworkConditions", networkConditionsFor(profile));
    } catch (err) {
      this.logger.warn("network_profile_failed", {
        profile,
        reason: errorMessage(err),
      });
    }
  }

  /** Whether a page needs the route handler (navigation blocking, faults, traceparent). */
  private needsRouting(): boolean {
    return !!(this.options.blockExternalNavigation || this.compiledFaultRules.length > 0 || this.options.traceparent);
  }

  /**
   * Whether the route handler has to see every request. Fault injection and
   * `traceparent` do by definition; HAR replay keeps the route so the blocking
   * decision stays ahead of `routeFromHAR` exactly as it was (the HAR's own
   * context route disables the cache anyway). Everything else — the default,
   * `blockExternalNavigation` alone — only needs navigations, which the CDP
   * guard sees without a route and therefore without switching the HTTP cache
   * off. See `navigation-guard.ts`.
   */
  private needsRequestRoute(): boolean {
    return !!(
      this.compiledFaultRules.length > 0 ||
      this.options.traceparent ||
      this.options.har?.mode === "replay"
    );
  }

  /**
   * Install whatever the page needs to block external navigation and inject
   * faults / traceparent: the per-request route when {@link needsRequestRoute},
   * otherwise the document-only CDP guard. A page with no CDP (a non-Chromium
   * page handed to `testPage`) falls back to the route. Then apply
   * `httpCache: false`.
   */
  private async setupPageInterception(page: Page): Promise<void> {
    if (this.needsRouting()) {
      if (this.needsRequestRoute() || !this.options.blockExternalNavigation) {
        await this.setupNavigationBlocking(page);
      } else if (!this.interceptedPages.has(page)) {
        try {
          const guard = await installNavigationGuard(page, {
            isExternal: (url) => this.isExternalUrl(url),
            onBlocked: (url) => this.noteBlockedNavigation(url),
          });
          this.interceptedPages.add(page);
          if (page === this.cdpPage) this.navigationGuards.set(page, guard);
        } catch (err) {
          this.logger.debug("navigation_guard_unavailable", { reason: errorMessage(err) });
          await this.setupNavigationBlocking(page);
        }
      }
    }
    if (this.options.httpCache === false) {
      try {
        const cdp = pageCdp(page);
        await cdp.enable("Network");
        await (await cdp.session()).send("Network.setCacheDisabled", { cacheDisabled: true });
      } catch (err) {
        this.logger.warn("http_cache_disable_failed", { reason: errorMessage(err) });
      }
    }
  }

  /** Bookkeeping for one blocked external navigation, whichever layer blocked it. */
  private noteBlockedNavigation(url: string): void {
    this.blockedExternalCount++;
    this.events.onBlockedNavigation?.(url);
    this.logger.logBlockedNavigation(url);
  }

  /**
   * Undo what {@link setupPageInterception} installed on a page that outlives
   * the crawl — the CDP-attach page, which belongs to the user's browser.
   */
  private async releaseCdpPageInterception(page: Page): Promise<void> {
    const handler = this.routeHandlers.get(page);
    const guard = this.navigationGuards.get(page);
    this.routeHandlers.delete(page);
    this.navigationGuards.delete(page);
    this.interceptedPages.delete(page);
    if (page.isClosed()) return;
    if (handler) await page.unroute("**/*", handler).catch(() => {});
    if (guard) await guard.dispose();
    if (this.options.httpCache === false) {
      await pageCdp(page)
        .session()
        .then((client) => client.send("Network.setCacheDisabled", { cacheDisabled: false }))
        .catch(() => {});
    }
  }

  /**
   * The per-request route. Every request on a routed page goes through it,
   * and Playwright disables the browser HTTP cache while a page has a route,
   * so a page that gets this is measured cold. Only installed when
   * {@link needsRequestRoute} (or when the CDP guard is unavailable).
   */
  private async setupNavigationBlocking(page: Page): Promise<void> {
    if (this.interceptedPages.has(page)) return;
    const blockExternal = this.options.blockExternalNavigation;
    const rules = this.compiledFaultRules;
    const traceparentEnabled = this.options.traceparent !== undefined && this.options.traceparent !== false;
    const traceparentHook =
      typeof this.options.traceparent === "object" ? this.options.traceparent.onInject : undefined;

    // Install a single route handler that first considers fault injection,
    // then falls back to external-navigation blocking, then continues.
    const handler = async (route: Route) => {
      const request = route.request();
      const url = request.url();
      const method = request.method().toUpperCase();

      // Decide on the traceparent header up front so it's attached to every
      // path through this handler (fault response, blocked, fallback).
      let outgoingHeaders: Record<string, string> | null = null;
      if (traceparentEnabled) {
        const reqHeaders = await request.allHeaders();
        const existingTp = reqHeaders["traceparent"];
        if (existingTp) {
          // Honour upstream propagation; record the correlation id on the
          // current action regardless of whether the user supplied a hook.
          const parts = parseTraceparent(existingTp);
          if (parts?.traceId) this.recordTraceId(parts.traceId);
          if (traceparentHook) {
            traceparentHook({
              url,
              method,
              traceparent: existingTp,
              traceId: parts?.traceId ?? "",
              spanId: parts?.spanId ?? "",
              existing: true,
            });
          }
        } else {
          const traceId = randomBytes(16).toString("hex"); // 32 hex chars
          const spanId = randomBytes(8).toString("hex"); // 16 hex chars
          const traceparent = `00-${traceId}-${spanId}-01`;
          outgoingHeaders = { ...reqHeaders, traceparent };
          this.recordTraceId(traceId);
          traceparentHook?.({
            url,
            method,
            traceparent,
            traceId,
            spanId,
            existing: false,
          });
        }
      }

      // 1. Fault injection has priority so tests can exercise backends that
      // would otherwise be allowed through. The decision — two passes,
      // shared occurrence numbering, lazy probability — lives in
      // `pickFaultRule` so that this handler and the public
      // `applyFaultRules` cannot drift: a rule encoded twice is the defect
      // this file has produced more than any other.
      const winner = pickFaultRule(rules, url, method, this.rng);
      if (winner) {
        // Before the fault runs: a delay's span is the one open when the
        // request was made, not the one open when the delay ends. The label
        // is `faultInjections[].rule`'s, so the two join by name.
        this.perf.noteFault(winner.rule.name ?? winner.pattern.toString());
        await applyFault(route, winner.rule.fault, (held) => this.holdRoute(held));
        return;
      }

      // 2. Block external navigation if requested.
      if (blockExternal && this.isExternalUrl(url)) {
        if (request.isNavigationRequest()) {
          this.noteBlockedNavigation(url);
          await route.abort("blockedbyclient");
          return;
        }
        // Allow non-navigation external requests (images, scripts, etc.)
      }

      // route.fallback() (not continue) so context-level routes — notably
      // routeFromHAR for replay — still get a chance to serve this request.
      // When traceparent injection is on, override headers; otherwise let the
      // request through unchanged.
      if (outgoingHeaders) {
        await route.fallback({ headers: outgoingHeaders });
      } else {
        await route.fallback();
      }
    };
    await page.route("**/*", handler);
    this.interceptedPages.add(page);
    if (page === this.cdpPage) this.routeHandlers.set(page, handler);
  }

  /**
   * Reclassify a 404 / 5xx page as recovered (navigating back to the last
   * good URL when recovery is on), or remember a clean 200 as the next
   * recovery target. Runs after the failure bundle and fault stats are
   * collected, since the recovery navigation takes the page away.
   */
  private async applyRecovery(page: Page, entry: QueueEntry, result: PageResult): Promise<void> {
    const { url, sourceUrl, method, sourceElement } = entry;
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
          await this.gotoAndSettle(page, this.lastSuccessfulUrl);
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
  }

  private async crawlPage(entry: QueueEntry): Promise<PageResult> {
    const page = this.cdpPage ?? await this.context!.newPage();
    const { url, sourceUrl, method, sourceElement } = entry;

    // Scope recovery diagnostics to this page only.
    this.currentPageActions = [];
    // Drop the previous page's lifecycle executor — next stage call
    // re-creates one against the current page.
    this.lifecycleExecutor = null;
    this.coverageCollector = null;

    if (this.options.network) {
      await this.applyNetworkProfile(page, this.options.network);
    }

    if (this.coverageFeedback) {
      // Start V8 precise coverage BEFORE goto so load-time function
      // execution is captured. The collector runs on the page's shared CDP
      // session: its `stop()` only sends `Profiler.stopPreciseCoverage` —
      // it neither disables a domain nor detaches the session — so it
      // cannot pull CDP out from under the network profile or a lifecycle
      // fault using the same session.
      try {
        const cdp = await pageCdp(page).session();
        this.coverageCollector = new CoverageCollector(cdp);
        await this.coverageCollector.start();
      } catch (err) {
        this.logger.warn("coverage_attach_failed", {
          url,
          reason: errorMessage(err),
        });
        this.coverageCollector = null;
      }
    }

    await this.setupPageInterception(page);

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

      // Merge runtime-fault stats from the in-page counter. Recovery
      // navigates away, so we collect before that path runs.
      await this.collectRuntimeFaultStats(page);
      await this.collectIframeFaultStats(page);

      await this.applyRecovery(page, entry, result);

      this.events.onPageComplete?.(result);
      this.logger.logPageComplete(result);
      return result;
    } finally {
      if (this.coverageCollector) {
        try {
          await this.coverageCollector.stop();
        } catch {
          /* page may already be closing — drop. */
        }
        this.coverageCollector = null;
      }
      // Release hung requests before the page goes away, so `page.close()`
      // isn't racing a route handler that never responded.
      await this.drainHeldRoutes();
      if (page !== this.cdpPage) await page.close();
    }
  }

  /**
   * Register the per-page error / warning / server-fault collectors. They
   * register in their original order: console, pageerror, response, then —
   * after `betweenRegistrations` (the page's init scripts) has run —
   * requestfailed. `stop()` turns collection off and detaches every handler.
   */
  private async attachPageCollectors(
    page: Page,
    errors: PageError[],
    warnings: string[],
    betweenRegistrations: () => Promise<void>,
  ): Promise<{ stop(): void }> {
    // Set to false once collection is done so spurious events fired during
    // page.close() (in-flight requests getting cancelled as ERR_ABORTED, etc.)
    // don't pollute the PageResult.
    let collecting = true;

    // Set up error listeners. Each error records `page.url()` at fire time
    // so that errors triggered after a chaos-action navigation are attributed
    // to the URL actually in the address bar, not the original crawlPage URL.
    const onConsole = (msg: ConsoleMessage) => {
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
        this.emitPageError(errors, error);
      } else if (type === "warning") {
        warnings.push(text);
      }
    };
    page.on("console", onConsole);

    // Capture unhandled exceptions
    const onPageError = (err: Error) => {
      if (!collecting) return;
      if (this.shouldIgnoreError(err.message)) return;
      const error: PageError = {
        type: "exception",
        message: err.message,
        stack: err.stack,
        url: page.url(),
        timestamp: Date.now(),
      };
      this.emitPageError(errors, error);
    };
    page.on("pageerror", onPageError);

    // Server-fault collector: when chaos() runs in remote-server mode, every
    // response carries `x-chaos-fault-*` headers describing any fault the
    // server-side middleware injected. Forward each response's headers to
    // the collector so `generateReport` (Task 13) can drain them.
    const collector = this.serverFaultCollector;
    const onResponse = collector
      ? (response: Response) => {
          if (!collecting) return;
          // Playwright's APIResponse / Response gives a plain object via headers().
          // Wrap in Headers so the collector's parser sees a Web-Standard surface.
          const h = new Headers();
          for (const [k, v] of Object.entries(response.headers())) h.set(k, v);
          collector.observe({ headers: h, pageUrl: page.url() });
        }
      : null;
    if (onResponse) page.on("response", onResponse);

    await betweenRegistrations();

    const onRequestFailed = (request: Request) => {
      if (!collecting) return;
      const requestUrl = request.url();
      // Test the pattern against the *message* — `"<url> - <errorText>"` — not
      // the URL alone. The doc on `ignoreErrorPatterns` promised
      // `PageError.message` for every error type, and this one path tested the
      // URL, so `"net::ERR_FAILED"` silenced the console copy of an aborted
      // request and left the network copy standing. Matching the message is a
      // superset: every pattern that matched the URL still matches.
      const failure = request.failure();
      const message = `${requestUrl} - ${failure?.errorText || "Unknown error"}`;
      if (this.shouldIgnoreError(message)) return;

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

      const error: PageError = {
        type: "network",
        message,
        url: page.url(),
        timestamp: Date.now(),
      };
      this.emitPageError(errors, error);
    };
    page.on("requestfailed", onRequestFailed);

    return {
      stop: () => {
        collecting = false;
        page.off("console", onConsole);
        page.off("pageerror", onPageError);
        if (onResponse) page.off("response", onResponse);
        page.off("requestfailed", onRequestFailed);
      },
    };
  }

  /**
   * Install this page's once-per-page init scripts: the unhandled-rejection
   * watcher and the SPA History-API hook.
   */
  private async installPageInitScripts(page: Page): Promise<void> {
    // Capture unhandled promise rejections. The install claims them via
    // `preventDefault` so they don't also fire as `pageerror` (which we'd
    // misclassify as an exception). Shared with the exported
    // `watchUnhandledRejections` rather than inlined twice — a harness written
    // against this library needs exactly the same mechanism, and two copies is
    // how one of them ends up without the `preventDefault`.
    if (this.initializedPages.has(page)) return;
    await watchUnhandledRejections(page);
    // Capture SPA route changes that go through the History API; see
    // `installSpaNavigationHook` for why `extractLinks` alone misses them.
    await installSpaNavigationHook(page);
    this.initializedPages.add(page);
  }

  private async crawlPageWithExistingPage(page: Page, url: string): Promise<PageResult> {
    const errors: PageError[] = [];
    const warnings: string[] = [];
    const blockedNavigations: string[] = [];
    const startTime = Date.now();

    this.events.onPageStart?.(url);
    this.logger.logPageStart(url);

    const collectors = await this.attachPageCollectors(page, errors, warnings, () =>
      this.installPageInitScripts(page),
    );

    // Track blocked external navigations
    const originalBlockedCount = this.blockedExternalCount;

    let result: PageResult;
    // Whether `page.goto` returned. Only a navigation that never did leaves a
    // load in flight for `finishPagePerf` to stop; a page that loaded and
    // then failed later (an action, an invariant, a screenshot) still has a
    // live document.
    let navigated = false;

    // Adaptive settle counts this page's requests from before its `goto`, so
    // the load's own requests are in flight when the load settle begins.
    const requestTracking = this.settle.mode === "adaptive" ? trackPageRequests(page) : null;
    this.pageRequests = requestTracking?.tracker ?? null;
    this.pageSettleCapped = 0;
    this.perf.clearPending();
    // The previous page's last action is over: this page's load requests are
    // not its. `performWeightedActions` clears this too, but only after the
    // load, and the load span's server-fault join needs the load's trace ids.
    this.currentAction = null;

    try {
      // beforeNavigation lifecycle faults — applied before the load itself,
      // so e.g. CDP CPU throttling slows the navigation request.
      await this.applyLifecycleStage("beforeNavigation", page, url);

      // The load span opens after the beforeNavigation faults, so it
      // measures the navigation under them rather than the faults' own
      // setup, and closes after `collectLoadMetrics` below.
      await this.beginLoadSpan(page, url);

      const { response, capped: loadCapped } = await this.gotoAndSettle(page, url);
      navigated = true;

      // Drain any unhandled rejections captured during load.
      this.reclassifyRejections(errors, await this.drainRejections(page), url);

      // afterLoad lifecycle faults — page exists, DOM is reachable, but no
      // chaos actions have run yet. Storage wipes and tampering happen here.
      await this.applyLifecycleStage("afterLoad", page, url);

      // Take an initial coverage snapshot so subsequent action deltas have
      // a baseline. The page-load attribution (functions executed during
      // navigation) folds straight into globalCoverage — no specific action
      // owns it.
      await this.recordPageLoadCoverage(url);

      await this.runInvariants("afterLoad", page, url, errors);

      const loadTime = Date.now() - startTime;
      const metrics = await collectLoadMetrics(page);
      // Strictly after `collectLoadMetrics`: it reads the collector's store
      // without draining it, and closing a span drains the store. The other
      // order would take LCP and TBT's long tasks away before they are read.
      await this.perf.endLoad({ settleCapped: loadCapped });
      this.enforcePerformanceBudget(metrics, url, errors);
      const links = await this.extractLinks(page);
      // History-API navigations that fired during page load (auto-routing
      // SPAs that redirect / on mount). Same de-dup happens at the queue
      // feeder, so duplicates between extractLinks and SPA drain are fine.
      await this.appendSpaLinks(page, links);

      // beforeActions lifecycle faults — invariants have passed, the chaos
      // driver is about to start. Service Worker cache eviction lives here.
      await this.applyLifecycleStage("beforeActions", page, url);

      // Replay mode bypasses the weighted random driver — playback owns
      // exactly what runs and in what order.
      if (this.currentReplayActions) {
        await this.performReplayActions(page, url, this.currentReplayActions);
      } else {
        await this.performWeightedActions(page, url);
      }

      // Drain any rejections that fired during actions.
      this.reclassifyRejections(errors, await this.drainRejections(page), url);

      // History-API navigations that fired DURING actions (every chaos
      // click on a React Router `<button onClick={navigate(...)}>`).
      await this.appendSpaLinks(page, links);

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
          message: errorMessage(err),
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
    // against this result. It also comes before `finishPagePerf`, for the
    // same reason: stopping a timed-out load aborts its requests, and what
    // the measurement itself causes must not reach the error stream, which
    // is what a crawl with perf off would report.
    collectors.stop();
    requestTracking?.detach();
    this.pageRequests = null;
    if (this.settle.mode === "adaptive") result.settleCapped = this.pageSettleCapped;

    // Both paths, before the caller navigates for recovery or closes the
    // page: a `goto` that timed out still yields a load span that says what
    // the attempt cost.
    await this.finishPagePerf(result, url, { navigationFailed: !navigated });

    // onPageComplete fires from the caller (crawlPage / testPage) after any
    // recovery reclassification so the callback sees the final status.
    return result;
  }

  /**
   * Open the page's perf session and its load span. A session that fails to
   * open (the CDP attach failed, the page is already gone) is logged and the
   * page is crawled unmeasured: measurement must never be why a page fails.
   */
  private async beginLoadSpan(page: Page, url: string): Promise<void> {
    await this.perf.beginPage(page, url, {
      // Decided per page, not per crawler: only a page in the context
      // `start()` created has the collector already. A caller's page on the
      // `testPage()` path belongs to a context the crawler never touched,
      // even when this same crawler ran `start()` before.
      installCollector: page.context() !== this.context,
      // The runtime-fault script is on every page of the crawl.
      pageFaults: this.compiledRuntimeFaults.map((c) => c.name),
    });
  }

  /**
   * Open a span for the action about to run, or null when actions are not
   * measured. Opened after `currentAction` is set to the placeholder, so the
   * span and the `traceIds` the placeholder collects cover the same step.
   */
  private async beginActionSpan(): Promise<SpanHandle | null> {
    return this.perf.beginAction();
  }

  /**
   * Settle after an action, then close the span `beginActionSpan` opened.
   *
   * Under `networkidle` the settle is the post-click `waitForLoadState` inside
   * `performActionOnTarget`, exactly as before, and nothing happens here.
   * Under adaptive settle every action that ran settles here, inside its span,
   * so the span covers what the step caused. A null result is a skipped
   * action: not a step, so it neither settles nor records a span.
   *
   * `settle: false` on the span because the crawler did the settling; the
   * span ends now, and carries `capped` when the crawler's settle capped.
   */
  private async endActionSpan(
    page: Page,
    span: SpanHandle | null,
    result: ActionResult | null,
  ): Promise<void> {
    const settleCapped =
      result !== null && this.settle.mode === "adaptive"
        ? await this.settleAdaptively(page, ACTION_SETTLE_CAP_MS, "action")
        : false;
    if (result === null) this.perf.cancelAction(span);
    else await this.perf.endAction(span, result, { settleCapped });
  }

  /**
   * Run one chosen action inside its perf span, with a placeholder standing in
   * as `currentAction` while it runs.
   *
   * The placeholder exists so traceIds captured during execution land on an
   * object before the real result exists; they are carried onto the (fresh)
   * result afterwards. A null result is a skipped action: `currentAction` is
   * left as the placeholder and the caller logs and moves on.
   *
   * Replay does not use this — it never had a placeholder or traceIds.
   */
  private async runMeasuredStep(
    page: Page,
    seed: { target: string; selector?: string },
    perform: () => Promise<ActionResult | null>,
  ): Promise<ActionResult | null> {
    const placeholder: ActionResult = {
      type: "click", // overwritten by the real result on success
      target: seed.target,
      ...(seed.selector !== undefined ? { selector: seed.selector } : {}),
      success: false,
      timestamp: Date.now(),
    };
    this.currentAction = placeholder;
    const span = await this.beginActionSpan();
    const result = await perform();
    await this.endActionSpan(page, span, result);
    if (result === null) return null;
    if (placeholder.traceIds) result.traceIds = placeholder.traceIds;
    this.currentAction = result;
    return result;
  }

  /** Record a performed action everywhere a performed action is reported. */
  private recordAction(result: ActionResult, url: string, stamp: TraceStamp | undefined): void {
    this.actions.push(result);
    this.addToHistory(result); // Add to recovery history
    if (this.isRecordingTrace()) this.trace.push(actionToTraceEntry(result, url, stamp));
    this.events.onAction?.(result);
    this.logger.logAction(result);
  }

  /**
   * The tail of a chaos action step: attribute its coverage, re-apply the
   * betweenActions lifecycle faults, then pause.
   */
  private async afterActionStep(page: Page, url: string, coverageSelector: string | null): Promise<void> {
    // Attribute V8 coverage executed during this action to the selected
    // target — feeds the novelty score that biases the next picks.
    if (coverageSelector !== null) await this.attributeActionCoverage(url, coverageSelector);
    // betweenActions lifecycle faults — re-applied after each chaos action
    // so sustained-pressure faults (CPU throttle, repeated tamper) keep
    // their pressure across the loop.
    await this.applyLifecycleStage("betweenActions", page, url);
    // Small delay between actions
    await this.pauseBetweenActions(page);
  }

  /**
   * `page.goto` and the load's settle.
   *
   * `networkidle` is the historic call, unchanged. Adaptive waits for `load`
   * — not `domcontentloaded`, so images and load-time scripts are in, the
   * same point `networkidle` starts its idle window from — then settles
   * adaptively for what is left of the same `timeout`. A load settle that
   * caps does not fail the page: the page loaded, and a load that never goes
   * quiet is reported as `capped` instead of as a navigation timeout.
   */
  private async gotoAndSettle(
    page: Page,
    url: string,
  ): Promise<{ response: Response | null; capped: boolean }> {
    if (this.settle.mode === "networkidle") {
      const response = await page.goto(url, {
        timeout: this.options.timeout,
        waitUntil: "networkidle",
      });
      return { response, capped: false };
    }
    // The recovery navigation runs after the page's own tracker is detached;
    // it gets one of its own for the length of the navigation.
    const temporary = this.pageRequests === null ? trackPageRequests(page) : null;
    const tracker = this.pageRequests ?? temporary!.tracker;
    try {
      const started = performance.now();
      const response = await page.goto(url, { timeout: this.options.timeout, waitUntil: "load" });
      const left = Math.max(0, this.options.timeout - (performance.now() - started));
      const capped = await this.settleAdaptively(page, left, "load", tracker);
      return { response, capped };
    } finally {
      temporary?.detach();
    }
  }

  /**
   * One adaptive settle, capped at `capMs`. Returns whether it capped, and
   * counts a capped one against the current page.
   */
  private async settleAdaptively(
    page: Page,
    capMs: number,
    stage: "load" | "action",
    tracker: RequestTracker | null = this.pageRequests,
  ): Promise<boolean> {
    if (this.settle.mode !== "adaptive" || tracker === null) return false;
    const outcome = await settleAdaptive(tracker, pageSettleEnv(page, tracker), {
      quietMs: this.settle.quietMs,
      capMs,
    });
    if (!outcome.capped) return false;
    this.pageSettleCapped++;
    this.logger.debug("settle_capped", {
      stage,
      url: page.url(),
      capMs,
      reason: outcome.reason,
    });
    return true;
  }

  /**
   * The pause between two actions: a fixed 100 ms under `networkidle`, as
   * before. Adaptive settle has already waited for the page inside the
   * action's span, so it adds nothing here.
   */
  private async pauseBetweenActions(page: Page): Promise<void> {
    if (this.settle.mode === "networkidle") await page.waitForTimeout(100);
  }

  /** Build the page's perf report and attach it to `result` and its actions. */
  private async finishPagePerf(
    result: PageResult,
    url: string,
    { navigationFailed }: { navigationFailed: boolean },
  ): Promise<void> {
    const violations = await this.perf.finishPage(result, url, { navigationFailed });
    // The errors go onto the result itself because the page is over — its
    // `errors` array is the one the report, clusters and exit code read.
    for (const error of violations) {
      this.emitPageError(result.errors, error);
    }
    if (violations.length > 0) result.hasErrors = true;
  }

  /** Record a page error and fan it out to the event hook and the logger. */
  private emitPageError(errors: PageError[], error: PageError): void {
    errors.push(error);
    this.events.onError?.(error);
    this.logger.logPageError(error);
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
      this.emitPageError(errors, error);
    }
  }

  private async extractLinks(page: Page): Promise<string[]> {
    try {
      const raw = await page.evaluate(collectRawLinks);
      return resolvePageLinks(raw).filter((link) => !this.isExternalUrl(link));
    } catch {
      return [];
    }
  }

  /**
   * Get action targets from DOM with accessibility-based weighting
   */
  private async getWeightedActionTargets(page: Page): Promise<ActionTarget[]> {
    let raw: RawActionTarget[];
    try {
      // Only the scrape is guarded. A page that refuses to be read leaves
      // nothing to click, so scrolling is the honest fallback — but a bug in
      // the weighting below should surface, not quietly reduce every page to
      // a scroll.
      raw = await page.evaluate(collectRawTargets);
    } catch {
      return scrollOnlyTargets();
    }
    return weighActionTargets(raw, {
      weights: this.actionWeights,
      baseOrigin: this.baseOrigin,
      familiarity: (url) => {
        if (this.visited.has(url)) return "visited";
        return this.queue.some((e) => e.url === url) ? "queued" : "new";
      },
    });
  }

  /**
   * Perform actions based on weighted random selection
   */
  private async performWeightedActions(page: Page, url: string): Promise<void> {
    // Per-page reset: if the previous page's last action left `currentAction`
    // pointing at it, requests fired during this page's load / navigation /
    // invariants would otherwise attribute to the previous page's last
    // action. Clearing here covers both the no-targets early-return below
    // and the regular-loop entry path.
    this.currentAction = null;

    const targets = await this.getWeightedActionTargets(page);
    this.logger.debug("action_targets", { count: targets.length, url });
    if (targets.length === 0) return;

    if (this.driver !== null) {
      return this.performDriverActions(page, url, targets);
    }

    let actionsPerformed = 0;
    let attempts = 0;
    const maxAttempts = this.options.maxActionsPerPage * 3; // Allow retries for skipped elements
    this.logger.debug("action_loop_start", { maxActionsPerPage: this.options.maxActionsPerPage, maxAttempts });

    while (actionsPerformed < this.options.maxActionsPerPage && attempts < maxAttempts) {
      attempts++;

      // Clear at the start of each iteration. Late-firing requests from the
      // previous action attach to the previous action; once we begin the next,
      // attribution is the current iteration's responsibility.
      this.currentAction = null;

      const advisorPick = await this.consultAdvisorIfStalled(page, url, targets);
      const selectedTarget =
        advisorPick ??
        weightedPick(
          targets,
          // Coverage-guided action selection: bias picks toward targets that
          // historically delivered new V8 coverage. `coverageWeightFor` returns
          // 1 when feedback is off, so the no-feedback path is unchanged.
          (t) => t.weight * this.coverageWeightFor(url, t.selector),
          this.rng,
        );

      const result = await this.runMeasuredStep(
        page,
        { target: selectedTarget.name ?? selectedTarget.selector, selector: selectedTarget.selector },
        () => this.performActionOnTarget(page, selectedTarget, url),
      );

      // Skip null results (element not visible)
      if (result === null) {
        this.logger.debug("action_skipped", { target: selectedTarget.name || selectedTarget.selector, reason: "not visible" });
        continue;
      }

      actionsPerformed++;
      // Consumed whether or not a trace is recorded, so a stale pick never
      // outlives the step it was made for.
      const advisorStamp = this.consumeAdvisorStamp(selectedTarget.selector);
      this.recordAction(result, url, advisorStamp);
      await this.afterActionStep(page, url, selectedTarget.selector);
    }
  }

  /**
   * Driver-based action loop. Replaces the weighted-random path when the
   * caller supplied `options.driver`. The crawler still owns target
   * discovery, action execution, history, lifecycle hooks, and coverage
   * attribution — the driver only decides *which* candidate to act on
   * each step. A `kind: "skip"` pick or a `null` return short-circuits
   * the step; the loop's attempt counter still ticks so a misbehaving
   * driver cannot loop forever.
   *
   * Targets are re-collected from the DOM before every step after the
   * first. A per-step driver that chose from a list built once per page
   * visit is choosing from a list the page has since thrown away: any app
   * that routes by hash or History API, or that opens a modal, changes its
   * controls without a navigation, and every step after the first would
   * pick from the controls of a screen the user has already left. That hit
   * `weightedRandomDriver` and `aiDriver` alike — it was never specific to
   * one driver. The re-collection costs one `page.evaluate` per step,
   * which is noise next to the model call a per-step driver is making.
   */
  private async performDriverActions(
    page: Page,
    url: string,
    initialTargets: ReadonlyArray<ActionTarget>,
  ): Promise<void> {
    const driver = this.driver;
    if (driver === null) return;

    driver.onPageStart?.(url);

    let targets = initialTargets;
    let candidates = toDriverCandidates(targets);
    const recentHistory: DriverHistoryEntry[] = [];
    // Drain any pre-loop violations (e.g. from `afterLoad` invariant checks)
    // so the driver's very first step already sees them.
    const pendingViolations: DriverInvariantViolation[] = this.driverPendingViolations.splice(0);

    const screenshotFn = async (mode: ScreenshotMode = "viewport") => {
      return page.screenshot({ fullPage: mode === "fullPage" });
    };

    let actionsPerformed = 0;
    let attempts = 0;
    const maxAttempts = this.options.maxActionsPerPage * 3;
    this.logger.debug("driver_loop_start", {
      driver: driver.name,
      maxActionsPerPage: this.options.maxActionsPerPage,
      maxAttempts,
    });

    while (actionsPerformed < this.options.maxActionsPerPage && attempts < maxAttempts) {
      attempts++;
      this.currentAction = null;

      // The caller's targets are current on entry; from the second attempt
      // on, the previous step may have re-rendered the screen.
      if (attempts > 1) {
        targets = await this.getWeightedActionTargets(page);
        if (targets.length === 0) {
          this.logger.debug("driver_no_targets", { attempts, url });
          break;
        }
        candidates = toDriverCandidates(targets);
      }

      // Drain violations that accumulated since the last step.
      if (this.driverPendingViolations.length > 0) {
        pendingViolations.push(...this.driverPendingViolations.splice(0));
      }

      let currentUrl = url;
      try {
        currentUrl = page.url();
      } catch {
        // Closed or crashed page — the page-visit URL is the honest answer.
      }

      const step: DriverStep = {
        url,
        currentUrl,
        page,
        candidates,
        history: recentHistory,
        stepIndex: actionsPerformed,
        rng: this.rng,
        screenshot: screenshotFn,
        invariantViolations: pendingViolations,
      };
      // Set only when measured, so a driver can tell "unmeasured" from
      // "cost nothing" by the field's presence.
      const lastActionPerf = this.perf.lastActionPerf();
      if (lastActionPerf) step.lastActionPerf = lastActionPerf;

      let pick: DriverPick | null;
      try {
        pick = await driver.selectAction(step);
      } catch (err) {
        this.logger.warn("driver_threw", {
          driver: driver.name,
          error: errorMessage(err),
        });
        pick = null;
      }

      if (pick === null || pick.kind === "skip") {
        this.logger.debug("driver_skipped", { driver: driver.name, attempts });
        continue;
      }

      let result: ActionResult | null;
      let selectorForCoverage: string | null = null;
      if (pick.kind === "custom") {
        const target = pick.source ?? driver.name;
        result = await this.runMeasuredStep(page, { target }, async () => {
          try {
            return await pick.perform(page);
          } catch (err) {
            return {
              type: "click",
              target,
              success: false,
              error: errorMessage(err),
              timestamp: Date.now(),
            };
          }
        });
        // A custom perform always yields a result (a throw becomes a failed
        // click), so there is no skip to handle here.
        if (result === null) continue;
      } else {
        const selectedTarget = targets[pick.index];
        if (!selectedTarget) {
          this.logger.warn("driver_out_of_range", { driver: driver.name, index: pick.index });
          continue;
        }
        if (pick.operation === "clear" && selectedTarget.type !== "input") {
          // Refused rather than attempted: `clear()` on a button throws,
          // and a thrown action is recorded against the page under test.
          // An unsupported operation is the driver's mistake, so it reads
          // like an out-of-range index — the step is not spent.
          this.logger.warn("driver_operation_unsupported", {
            driver: driver.name,
            operation: pick.operation,
            targetType: selectedTarget.type,
          });
          continue;
        }
        selectorForCoverage = selectedTarget.selector;
        const operation = pick.operation;
        result = await this.runMeasuredStep(
          page,
          { target: selectedTarget.name ?? selectedTarget.selector, selector: selectedTarget.selector },
          () => this.performActionOnTarget(page, selectedTarget, url, operation),
        );
        if (result === null) {
          this.logger.debug("driver_action_skipped", {
            target: selectedTarget.name || selectedTarget.selector,
            reason: "not visible",
          });
          continue;
        }
      }

      actionsPerformed++;
      this.recordAction(result, url, driverTraceStamp(pick, driver.name));

      try {
        driver.onActionComplete?.(result, step);
      } catch (err) {
        this.logger.warn("driver_onActionComplete_threw", {
          driver: driver.name,
          error: errorMessage(err),
        });
      }

      recentHistory.push({
        type: result.type,
        target: result.target,
        success: result.success,
        error: result.error,
      });
      // Cap the history that drivers see; long-running pages should not
      // balloon prompt size.
      if (recentHistory.length > 10) recentHistory.shift();
      // Violations are point-in-time signals — clear once a step has seen
      // them.
      pendingViolations.length = 0;

      await this.afterActionStep(page, url, selectorForCoverage);
    }

    driver.onPageEnd?.(url);
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
      const span = await this.beginActionSpan();
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
          error: errorMessage(err),
          timestamp,
        };
      }
      await this.endActionSpan(page, span, result);
      this.recordAction(result, url, undefined);
      this.recordReplayOutcome(action, result);
      await this.pauseBetweenActions(page);
    }
  }

  private recordReplayOutcome(action: TraceAction, result: ActionResult): void {
    const f = this.replayFidelity;
    if (!f) return;
    f.totalActions += 1;
    if (result.success) {
      f.succeeded += 1;
      return;
    }
    if (result.error?.startsWith("replay: entry has no selector")) {
      f.noSelectorRecorded += 1;
    } else if (result.error?.startsWith("replay: element not visible")) {
      f.selectorMissing += 1;
    } else {
      f.threw += 1;
    }
  }

  private async performActionOnTarget(
    page: Page,
    target: ActionTarget,
    url: string,
    operation?: DriverOperation
  ): Promise<ActionResult | null> {
    const timestamp = Date.now();
    // What this action is, fixed before it is attempted, so a failed fill
    // is reported as the fill it was rather than as a click. The perf key is
    // built from the result's type, and a step that is keyed one way when it
    // works and another when it throws would split its baseline in two —
    // with the slow, faulted run being the one that loses its match.
    const attemptedType = attemptedActionType(target.type, operation);
    // Success result for a plain element action. Results that carry an extra
    // field (value, blockedExternal, shardSkipped) stay spelled out below:
    // it sits before success/timestamp there, and report JSON keeps key order.
    const ok = (type: ActionResult["type"]): ActionResult => ({
      type,
      target: target.name || target.selector,
      selector: target.selector,
      success: true,
      timestamp,
    });

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

      if (target.type === "select") {
        // Nothing to set: one real option and the dropdown is already on
        // it. Skipped rather than attempted, the same as a non-visible
        // target — `selectOption` with the current value would succeed
        // and change nothing, which is a step spent looking productive.
        if (target.selectValue === undefined) return null;
        await element.selectOption(target.selectValue, { timeout: 1000 });
        return {
          type: "select",
          target: target.name || target.selector,
          selector: target.selector,
          value: target.selectValue,
          success: true,
          timestamp,
        };
      }

      if (target.type === "input") {
        if (operation === "clear") {
          // `clear()` is `fill("")`, so it accepts exactly the controls
          // that made this target an `input` in the first place.
          await element.clear({ timeout: 1000 });
          return ok("clear");
        }
        await element.fill(target.fillValue ?? DEFAULT_FILL_VALUE, { timeout: 1000 });
        return ok("input");
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

      // Wait for any navigation to settle. Note what this does not do: when
      // the current document already reached networkidle — it has, the load
      // waited for it — this resolves at once, so a click that only fires an
      // XHR is not waited for. Adaptive settle (`endActionSpan`) waits for
      // the page's requests instead; this call stays as it was under the
      // default `networkidle`.
      if (this.settle.mode === "networkidle") {
        await page.waitForLoadState("networkidle", { timeout: 2000 }).catch(() => {});
      }

      return ok("click");
    } catch (err) {
      // A scroll's "selector" is the placeholder `window`, which a successful
      // scroll never reports; leaving it off keeps both keyed as `scroll`.
      return {
        type: attemptedType,
        target: target.name || target.selector,
        ...(attemptedType === "scroll" ? {} : { selector: target.selector }),
        success: false,
        error: errorMessage(err),
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

    const drainedServerFaults =
      this.serverFaultCollector && this.serverFaultCollector.size() > 0
        ? this.serverFaultCollector.drain()
        : null;

    if (drainedServerFaults) {
      // Per-page join — same references as the flat list.
      for (const p of this.results) {
        const events = drainedServerFaults.filter((e) => e.pageUrl === p.url);
        if (events.length > 0) p.serverFaultEvents = events;
      }
      // Per-action join — only meaningful when traceparent injection is on
      // (otherwise traceIds is always empty/absent).
      for (const a of this.actions) {
        if (!a.traceIds || a.traceIds.length === 0) continue;
        const set = new Set(a.traceIds);
        const events = drainedServerFaults.filter((e) => e.traceId !== undefined && set.has(e.traceId));
        if (events.length > 0) a.serverFaultEvents = events;
      }
      // The same join by trace id, onto the perf spans: each span is tagged
      // `server:<kind>` for the server faults its requests hit.
      tagServerFaults(
        [
          ...this.perf.loadTraceIds,
          ...this.actions.flatMap((a) => (a.perf ? [{ span: a.perf, traceIds: a.traceIds }] : [])),
        ],
        drainedServerFaults,
      );
    }

    return {
      baseUrl: this.options.baseUrl,
      seed: this.rng.seed,
      reproCommand: buildReproCommand(this.options, this.rng.seed),
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
      heldRequests: this.heldRequests > 0 ? this.heldRequests : undefined,
      lifecycleFaults:
        this.compiledLifecycleFaults.length > 0
          ? lifecycleStatsFrom(this.compiledLifecycleFaults)
          : undefined,
      runtimeFaults:
        this.compiledRuntimeFaults.length > 0
          ? this.compiledRuntimeFaults.map((c) => ({
              rule: c.name,
              matched: c.matched,
              fired: c.fired,
            }))
          : undefined,
      iframeFaults:
        this.compiledIframeFaults.length > 0
          ? this.compiledIframeFaults.map((c) => ({
              rule: c.name,
              selector: c.fault.selector,
              action: c.fault.action.kind,
              matched: c.matched,
              fired: c.fired,
            }))
          : undefined,
      coverage: this.coverageFeedback
        ? summarizeCoverage({
            globalCovered: this.globalCoverage,
            pageDeltas: this.pageCoverageDeltas,
            targetNovelty: this.targetNovelty,
            topN: this.coverageFeedback.topN,
          })
        : undefined,
      coverageFingerprint:
        this.coverageFeedback && this.globalCoverage.size > 0
          ? coverageFingerprintOf(this.globalCoverage)
          : undefined,
      advisor: this.advisorRuntime
        ? {
            provider: this.advisorRuntime.provider.name,
            callsAttempted: this.advisorRuntime.callsAttempted,
            callsSucceeded: this.advisorRuntime.callsSucceeded,
            picks: [...this.advisorRuntime.picks],
          }
        : undefined,
      replayFidelity: this.replayFidelity ? { ...this.replayFidelity } : undefined,
      errorClusters: clusterErrors(this.results.flatMap((r) => r.errors)),
      har: this.options.har,
      // Field is omitted when no faults observed (matches advisor / coverage convention).
      serverFaults: drainedServerFaults ?? undefined,
      perf: buildCrawlPerfSummary(this.results, this.actions, {
        ...(this.perf.coverage ? { coverage: this.perf.coverage } : {}),
        settle: this.settle,
      }),
    };
  }

  /** Per-rule fault injection stats (for reporting). */
  getFaultStats(): FaultInjectionStats[] {
    return this.compiledFaultRules.map((c) => ({
      rule: c.rule.name ?? c.pattern.toString(),
      matched: c.matched,
      injected: c.injected,
      ...(c.suppressed > 0 ? { suppressed: c.suppressed } : {}),
    }));
  }

  private calculateSummary(): CrawlSummary {
    return summarizePages(this.results, this.discoveryMetrics);
  }
}
