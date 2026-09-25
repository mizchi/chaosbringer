/**
 * Crawler ⇄ lightbringer glue: one measured page visit.
 *
 * The crawler decides *when* a span opens and closes — around `page.goto`
 * and around each chaos action — and lightbringer does the measuring. This
 * class owns the mapping between the two: it opens a lightbringer session on
 * the page's shared CDP session, remembers which span belongs to which
 * crawler result, and after `finish()` writes each span back onto that
 * result. Naming and trimming rules live in `perf-key.ts`, which is pure.
 *
 * Nothing here throws into the crawl. lightbringer's span calls already
 * tolerate a page that navigated or closed mid-span; the one call that can
 * still fail — opening the session — is caught by the crawler, which then
 * crawls the page unmeasured.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CDPSession, Page } from "playwright";
import type { CoverageArtifact, PerfReport, PerfSession, SpanHandle } from "lightbringer/core";
import {
  endIfRecorded,
  FINISH_TIMEOUT_MS,
  openPerfSession,
} from "./perf-session.js";
import { raceTimeout, TIMED_OUT } from "./async-util.js";
import { SpanFaultTags } from "./perf-faults.js";
import { actionKind, actionRouteUrl, loadSpanName, perfKey, perfSlug } from "./perf-key.js";
import type { ResolvedPerfOptions } from "./perf-options.js";
import { toLastActionPerf, toPerfSpanReport } from "./perf-trim.js";
import type {
  ActionResult,
  LastActionPerf,
  PagePerfSummary,
  PageResult,
  PerfSpanReport,
} from "./types.js";

/**
 * Who a recorded span belongs to, in the order the spans were recorded.
 * `settleCapped`: the crawler's own settle for this step hit its cap (adaptive
 * settle only). lightbringer's `capped` means *its* settle capped, which never
 * happens here (spans end with `settle: false`), so the crawler's verdict is
 * what the span reports.
 */
type SpanOwner = (
  | { kind: "load"; settleCapped: boolean }
  | { kind: "action"; action: ActionResult; settleCapped: boolean; routeUrl: string }
) & { faults?: string[] };

// Moved to the leaf `perf-session.ts` (shared with the load runner); kept
// exported here for existing importers.

export class PagePerf {
  private loadHandle: SpanHandle | null = null;
  private readonly openActions = new Set<SpanHandle>();
  private readonly owners: SpanOwner[] = [];
  private readonly faultTags: SpanFaultTags<SpanHandle>;
  /**
   * Trace ids of the requests made while the load span was open. An action's
   * requests go onto its `ActionResult.traceIds`; a load has no such field,
   * so its ids are kept here for the server-fault join.
   */
  private readonly loadIds: string[] = [];
  /** The load span's report after `finish()`, for `loadTraceIds`. */
  private loadReport: PerfSpanReport | null = null;
  /**
   * The most recent action that ran on this page: its span's index in the
   * controller, or null when its span was not recorded — so a stale span
   * from an earlier action is never reported as the last one's.
   */
  private lastAction: { spanIndex: number; action: ActionResult; routeUrl: string } | null = null;
  /**
   * The URL each open action span's key is built from: the page's own URL
   * when the action began (see `actionRouteUrl`), not the visit's.
   */
  private readonly actionRouteUrls = new Map<SpanHandle, string>();
  /** `lastActionPerf()`'s answer for `lastAction`, once it was asked for. */
  private lastActionFacts: LastActionPerf | undefined;
  /** The page's coverage artifact after `finish()` (`perf.coverage` only). */
  coverage: CoverageArtifact | undefined;

  private constructor(
    private readonly session: PerfSession,
    private readonly client: CDPSession,
    private readonly url: string,
    private readonly opts: ResolvedPerfOptions,
    private readonly slug: string,
    pageFaults: readonly string[],
    /** For the live URL an action's key is built from; absent in unit fakes. */
    private readonly page?: Pick<Page, "url">,
  ) {
    this.faultTags = new SpanFaultTags(pageFaults);
  }

  /**
   * Open a lightbringer session on `page`. `installCollector` is false when
   * the crawler already installed the collector at context level — ahead of
   * the runtime-fault script, which is what keeps a `clock-skew` fault from
   * reaching the clock it captures. On the `testPage()` path the crawler owns
   * no context, so the collector goes onto the page instead.
   *
   * CPU and network throttling are never passed: the crawler owns both
   * (`faults.cpu()`, `network`), and lightbringer applying its own would
   * overwrite them on the same CDP session. `PerfSessionOptions` has no field
   * for either, so the compiler holds this.
   *
   * `pageFaults` are faults in effect for the whole visit (the crawl's
   * runtime faults); every span of the page is tagged with them.
   */
  static async open(
    page: Page,
    url: string,
    opts: ResolvedPerfOptions,
    {
      pageIndex,
      runId,
      installCollector,
      pageFaults = [],
    }: {
      pageIndex: number;
      runId: string;
      installCollector: boolean;
      pageFaults?: readonly string[];
    },
  ): Promise<PagePerf> {
    const slug = perfSlug(url, pageIndex, runId);
    let tracePath: string | undefined;
    if (opts.level === "trace" && opts.outDir) {
      mkdirSync(opts.outDir, { recursive: true });
      tracePath = join(opts.outDir, `${slug}.trace.json`);
    }
    const { client, session } = await openPerfSession(page, {
      installCollector,
      trace: tracePath !== undefined,
      ...(tracePath !== undefined ? { tracePath } : {}),
      memGc: opts.memGc,
      coverage: opts.coverage,
      cssStats: opts.cssSelectorStats,
    });
    return new PagePerf(session, client, url, opts, slug, pageFaults, page);
  }

  /** Open the page-load span. Call right before `page.goto`. */
  async beginLoad(): Promise<void> {
    if (this.loadHandle) return;
    this.loadHandle = await this.session.controller.begin(loadSpanName(this.url));
    this.faultTags.begin(this.loadHandle);
  }

  /**
   * A fault took effect now: tag every open span with it. `persistent` for a
   * fault whose effect outlasts the moment it fired (a lifecycle fault), so
   * spans opened later in the visit are tagged too.
   */
  noteFault(name: string, opts: { persistent?: boolean } = {}): void {
    this.faultTags.note(name, opts);
  }

  /** A request made during the load carried this trace id. */
  noteLoadTraceId(traceId: string): void {
    if (this.loadHandle) this.loadIds.push(traceId);
  }

  /**
   * The load span's report and its requests' trace ids, after `finish()`;
   * null when the page recorded no load span.
   */
  loadTraceIds(): { span: PerfSpanReport; traceIds: string[] } | null {
    return this.loadReport ? { span: this.loadReport, traceIds: [...this.loadIds] } : null;
  }

  /**
   * Close the page-load span. `settle: false` because the crawler has already
   * settled the load and run its `afterLoad` work; the span ends now.
   */
  async endLoad({ settleCapped = false }: { settleCapped?: boolean } = {}): Promise<void> {
    const handle = this.loadHandle;
    if (!handle) return;
    this.loadHandle = null;
    await this.record(handle, { kind: "load", settleCapped });
  }

  /** Open an action span. The name is provisional; `finish()` names it from the result. */
  async beginAction(): Promise<SpanHandle> {
    // Read before `begin` awaits, so the route is the one the action is
    // about to run on. `page.url()` is synchronous and only throws on a
    // closed page, where the visit URL is the honest answer.
    let liveUrl = this.url;
    try {
      if (this.page) liveUrl = this.page.url();
    } catch {
      // closed page
    }
    const routeUrl = actionRouteUrl(this.url, liveUrl);
    const handle = await this.session.controller.begin("action");
    this.actionRouteUrls.set(handle, routeUrl);
    this.openActions.add(handle);
    this.faultTags.begin(handle);
    return handle;
  }

  /** Close an action span and tie it to the result the action produced. */
  async endAction(
    handle: SpanHandle,
    action: ActionResult,
    { settleCapped = false }: { settleCapped?: boolean } = {},
  ): Promise<void> {
    if (!this.openActions.delete(handle)) return;
    const routeUrl = this.actionRouteUrls.get(handle) ?? this.url;
    this.actionRouteUrls.delete(handle);
    const spanIndex = await this.record(handle, { kind: "action", action, settleCapped, routeUrl });
    this.lastAction = spanIndex === null ? null : { spanIndex, action, routeUrl };
    this.lastActionFacts = undefined;
  }

  /**
   * What the most recent action on this page cost, for the next step's driver
   * or advisor; undefined when no action ran yet or its span was not
   * recorded. Built on first ask from what lightbringer has gathered so far
   * (`peekSpan`: node-side filtering, no page call) and kept, so a step that
   * asks twice — or a crawl that never asks — pays once or not at all.
   */
  lastActionPerf(): LastActionPerf | undefined {
    const last = this.lastAction;
    if (!last) return undefined;
    if (this.lastActionFacts) return this.lastActionFacts;
    const span = this.session.peekSpan(last.spanIndex);
    if (!span) return undefined;
    this.lastActionFacts = toLastActionPerf(span, perfKey(last.routeUrl, actionKind(last.action)));
    return this.lastActionFacts;
  }

  /** Drop an action span without recording it — the action was skipped. */
  cancelAction(handle: SpanHandle): void {
    if (!this.openActions.delete(handle)) return;
    this.actionRouteUrls.delete(handle);
    this.faultTags.end(handle);
    this.session.controller.cancel(handle);
  }

  /**
   * Build the page's report and attach it: the load span to `result.perf`,
   * page extras to `result.perfPage`, and each action span to the
   * `ActionResult` it measured — the same objects the crawler already pushed
   * into its report, mutated in place. Returns the attached spans, load
   * first, for the crawler's `perfBudgets` check.
   *
   * A load span still open (the `goto` threw) is closed first, so a timed-out
   * navigation still reports what it cost. Action spans still open belong to
   * actions that never produced a result; they are dropped.
   *
   * Every in-page read lightbringer makes is bounded by its
   * `evaluateTimeoutMs`, and after one read times out the rest return at
   * once. The CDP calls that are not reads (coverage stop, forced GC) have no
   * such bound, so the whole call is also raced against `timeoutMs`
   * (FINISH_TIMEOUT_MS); past it, it throws and the page goes unmeasured.
   *
   * `navigationFailed` still stops the page's pending load first — not to
   * avoid a hang any more, but for the data: after a `goto` that timed out on
   * a document request nobody answers, the navigation is still in flight and
   * Playwright holds every `page.evaluate` for the new document's context,
   * so without the stop each read would time out into its fallback and the
   * load span would lose the in-page part (long tasks, frames) of what the
   * attempt cost. `Page.stopLoading` is the browser's stop button; the old
   * document's context answers at once. The crawler passes it only when the
   * `goto` itself did not return: stopping the load of a page that did load
   * would abort its in-flight fetches, which only a perf run would do.
   */
  async finish(
    result: PageResult,
    {
      navigationFailed = false,
      timeoutMs = FINISH_TIMEOUT_MS,
    }: { navigationFailed?: boolean; timeoutMs?: number } = {},
  ): Promise<PerfSpanReport[]> {
    if (navigationFailed) await this.client.send("Page.stopLoading").catch(() => {});
    const outcome = await raceTimeout(this.build(result), timeoutMs);
    // The crawler logs this as `perf_finish_failed` and keeps crawling.
    if (outcome === TIMED_OUT) throw new Error(`perf finish timed out after ${timeoutMs}ms`);
    return outcome;
  }

  private async build(result: PageResult): Promise<PerfSpanReport[]> {
    if (this.loadHandle) await this.endLoad();
    for (const handle of this.openActions) {
      this.faultTags.end(handle);
      this.session.controller.cancel(handle);
    }
    this.openActions.clear();

    const { report, covArtifact } = await this.session.finish(loadSpanName(this.url));
    this.coverage = covArtifact;

    // `report.spans` is in the order the spans were recorded, which is the
    // order `record()` pushed their owners.
    const attached: PerfSpanReport[] = [];
    const sidecarSpans = report.spans.map((span, i) => {
      const owner = this.owners[i];
      if (!owner) return span;
      const kind = owner.kind === "load" ? "load" : actionKind(owner.action);
      const name = owner.kind === "load" ? loadSpanName(this.url) : kind;
      const key = perfKey(owner.kind === "load" ? this.url : owner.routeUrl, kind);
      // Re-spreading `name`/`key` keeps the positions `toPerfSpanReport` gave
      // them; `capped`/`faults` land where the old assignments put them.
      const decor = {
        name,
        key,
        ...(owner.settleCapped ? { capped: true } : {}),
        ...(owner.faults ? { faults: owner.faults } : {}),
      };
      const trimmed: PerfSpanReport = { ...toPerfSpanReport(span, key, name), ...decor };
      if (owner.kind === "load") {
        this.loadReport = trimmed;
        result.perf = trimmed;
        attached.unshift(trimmed);
      } else {
        owner.action.perf = trimmed;
        attached.push(trimmed);
      }
      return { ...span, ...decor };
    });

    const summary = pageSummary(report);
    if (this.opts.outDir) {
      mkdirSync(this.opts.outDir, { recursive: true });
      const reportPath = `${this.slug}.json`;
      writeFileSync(
        join(this.opts.outDir, reportPath),
        JSON.stringify({ ...report, spans: sidecarSpans }, null, 2),
      );
      if (covArtifact) {
        writeFileSync(
          join(this.opts.outDir, `${this.slug}.coverage.json`),
          JSON.stringify(covArtifact),
        );
      }
      summary.reportPath = reportPath;
    }
    result.perfPage = summary;
    return attached;
  }

  /**
   * End a span and remember its owner — but only if lightbringer really
   * recorded it. `end()` of a handle it no longer knows is a no-op, and an
   * owner pushed for a span that was never recorded would shift every later
   * span onto the wrong result. Returns the recorded span's controller index,
   * or null when nothing was recorded.
   */
  private async record(handle: SpanHandle, owner: SpanOwner): Promise<number | null> {
    // Read the tags before `end()` awaits: a fault that fires while lightbringer
    // is still reading the span's metrics happened after the span closed.
    // (`faultTags.end` is synchronous and leaves `controller.spans` alone, so
    // reading it before `endIfRecorded` takes its `before` count is the same.)
    const faults = this.faultTags.end(handle);
    if (!(await endIfRecorded(this.session.controller, handle))) return null;
    this.owners.push(faults ? { ...owner, faults } : owner);
    return this.session.controller.spans.length - 1;
  }
}

/** The page-level slice of a lightbringer report that goes into the crawl report. */
function pageSummary(report: PerfReport): PagePerfSummary {
  const net = report.network;
  const summary: PagePerfSummary = {
    vitals: report.vitals,
    network: {
      totalRequests: net.totalRequests,
      totalEncodedKB: net.totalEncodedKB,
      fromCacheCount: net.fromCacheCount,
      ...(net.thirdParty.requestCount > 0
        ? {
            thirdParty: {
              requestCount: net.thirdParty.requestCount,
              encodedKB: net.thirdParty.encodedKB,
            },
          }
        : {}),
    },
  };
  if (report.documents) summary.documents = report.documents;
  if (report.clockPatched) summary.clockPatched = true;
  if (report.collectorMissing) summary.collectorMissing = true;
  return summary;
}
