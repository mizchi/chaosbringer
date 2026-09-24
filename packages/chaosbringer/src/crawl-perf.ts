/**
 * Per-crawl perf bookkeeping: the crawler's side of `PagePerf`.
 *
 * `PagePerf` measures one page visit; this class holds what outlives a visit
 * (the page index and run id that name sidecar files, the load spans' trace
 * ids for the server-fault join, the crawl's merged coverage) and the state
 * between two visits (faults that fired before a page's session opened). The
 * crawler still decides *when* each call happens — around `page.goto`, the
 * metrics read, each action — so every call here maps to one call site there.
 *
 * Internal: not exported from the package index.
 */

import { randomBytes } from "node:crypto";
import type { Page } from "playwright";
import { mergeCoverageArtifacts, type CoverageArtifact, type SpanHandle } from "lightbringer/core";
import { checkPerfBudgets } from "./budget.js";
import { errorMessage } from "./errors.js";
import type { Logger } from "./logger.js";
import { PagePerf } from "./perf.js";
import type { ResolvedPerfOptions } from "./perf-options.js";
import type {
  ActionResult,
  LastActionPerf,
  PageError,
  PageResult,
  PerfBudgetRule,
  PerfSpanReport,
} from "./types.js";

export class CrawlPerf {
  /**
   * The current page's measurement, from just before its `goto` to the end
   * of `crawlPageWithExistingPage`. Null with perf off, and between pages.
   */
  private page: PagePerf | null = null;
  /** Pages measured so far this run; numbers the per-page sidecar files. */
  private pageIndex = 0;
  /**
   * Prefix of this run's sidecar file names. The page index alone restarts at
   * 0 in every crawler, and the Playwright fixture builds a crawler per test,
   * so without it every test's first page would write `000-<route>.json` and
   * overwrite the previous test's report (or race it, across workers).
   */
  private runId = randomBytes(4).toString("hex");
  /**
   * Lifecycle faults that fired on the current page before its perf session
   * opened (`beforeNavigation` runs ahead of the load span). They are still
   * in effect when the load runs, so the load span is tagged with them.
   */
  private pendingFaults: string[] = [];
  /**
   * Each measured page's load span with the trace ids its requests carried,
   * for the server-fault join in `generateReport` (actions carry theirs on
   * `ActionResult.traceIds`).
   */
  private loadIds: Array<{ span: PerfSpanReport; traceIds: string[] }> = [];
  /**
   * The crawl's JS/CSS coverage, every measured page's artifact folded in as
   * the page finishes (`perf.coverage` only). One merged artifact rather
   * than one per page: its size is bounded by the site's resources.
   */
  private mergedCoverage: CoverageArtifact | null = null;

  constructor(
    private readonly perfOptions: ResolvedPerfOptions | null,
    private readonly logger: Logger,
    private readonly perfBudgets: readonly PerfBudgetRule[] | undefined,
  ) {}

  /** Whether per-step measurement is on for this crawl. */
  get enabled(): boolean {
    return this.perfOptions !== null;
  }

  /** Start of a run (`start()`): fresh run id and page numbering, nothing carried over. */
  reset(): void {
    this.pageIndex = 0;
    this.runId = randomBytes(4).toString("hex");
    this.loadIds = [];
    this.mergedCoverage = null;
  }

  /** Start of a page visit: the previous page's pending faults are not this one's. */
  clearPending(): void {
    this.pendingFaults = [];
  }

  /**
   * Open the page's perf session and its load span. A session that fails to
   * open (the CDP attach failed, the page is already gone) is logged and the
   * page is crawled unmeasured: measurement must never be why a page fails.
   */
  async beginPage(
    page: Page,
    url: string,
    { installCollector, pageFaults }: { installCollector: boolean; pageFaults: readonly string[] },
  ): Promise<void> {
    this.page = null;
    if (!this.perfOptions) {
      this.pendingFaults = [];
      return;
    }
    try {
      const perf = await PagePerf.open(page, url, this.perfOptions, {
        pageIndex: this.pageIndex++,
        runId: this.runId,
        installCollector,
        pageFaults,
      });
      await perf.beginLoad();
      for (const name of this.pendingFaults) perf.noteFault(name, { persistent: true });
      this.page = perf;
    } catch (err) {
      this.logger.warn("perf_session_failed", {
        url,
        reason: errorMessage(err),
      });
    }
  }

  /**
   * A fault took effect now. With a page open it tags the open spans. With
   * none (perf on, session not open yet or failed to open), only a
   * `persistent` fault is kept for the next load span: a momentary one is
   * over before any span could contain it.
   */
  noteFault(name: string, { persistent = false }: { persistent?: boolean } = {}): void {
    if (this.page) this.page.noteFault(name, persistent ? { persistent: true } : {});
    else if (persistent && this.perfOptions) this.pendingFaults.push(name);
  }

  /** A request of the page load carried this trace id (no-op unless the load span is open). */
  noteLoadTraceId(traceId: string): void {
    this.page?.noteLoadTraceId(traceId);
  }

  /** Close the page-load span. */
  async endLoad(opts: { settleCapped?: boolean } = {}): Promise<void> {
    await this.page?.endLoad(opts);
  }

  /**
   * Open a span for the action about to run, or null when actions are not
   * measured.
   */
  async beginAction(): Promise<SpanHandle | null> {
    if (!this.page || this.perfOptions?.actions !== true) return null;
    return this.page.beginAction();
  }

  /** Close an action span and tie it to the result the action produced. */
  async endAction(
    span: SpanHandle | null,
    result: ActionResult,
    { settleCapped }: { settleCapped: boolean },
  ): Promise<void> {
    if (span === null || !this.page) return;
    await this.page.endAction(span, result, { settleCapped });
  }

  /** Drop an action span without recording it — the action was skipped. */
  cancelAction(span: SpanHandle | null): void {
    if (span === null || !this.page) return;
    this.page.cancelAction(span);
  }

  /** What the most recent action on the current page cost; undefined without one. */
  lastActionPerf(): LastActionPerf | undefined {
    return this.page?.lastActionPerf();
  }

  /**
   * Build the page's perf report and attach it to `result` and its actions.
   * Returns the page's `perfBudgets` violations for the crawler to emit;
   * empty when the page was unmeasured or its report failed.
   */
  async finishPage(
    result: PageResult,
    url: string,
    { navigationFailed }: { navigationFailed: boolean },
  ): Promise<PageError[]> {
    const perf = this.page;
    if (!perf) return [];
    this.page = null;
    let spans: PerfSpanReport[];
    try {
      spans = await perf.finish(result, { navigationFailed });
    } catch (err) {
      this.logger.warn("perf_finish_failed", {
        url,
        reason: errorMessage(err),
      });
      return [];
    }
    const load = perf.loadTraceIds();
    if (load && load.traceIds.length > 0) this.loadIds.push(load);
    if (perf.coverage) {
      this.mergedCoverage = mergeCoverageArtifacts(this.mergedCoverage ?? {}, perf.coverage);
    }
    // Here rather than at each span's end: an action's key needs its result,
    // and the spans only exist once lightbringer has built the page report.
    return checkPerfBudgets(spans, this.perfBudgets, url);
  }

  /** Every measured page's load span with its trace ids, for the server-fault join. */
  get loadTraceIds(): ReadonlyArray<{ span: PerfSpanReport; traceIds: string[] }> {
    return this.loadIds;
  }

  /** The crawl's merged coverage artifact; null when none was collected. */
  get coverage(): CoverageArtifact | null {
    return this.mergedCoverage;
  }
}
