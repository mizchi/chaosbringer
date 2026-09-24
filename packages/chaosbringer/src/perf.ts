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
import { startSession, type PerfReport, type PerfSession, type SpanHandle } from "lightbringer/core";
import { pageCdp } from "./page-cdp.js";
import {
  actionKind,
  loadSpanName,
  perfKey,
  perfSlug,
  toPerfSpanReport,
  type ResolvedPerfOptions,
} from "./perf-key.js";
import type { ActionResult, PagePerfSummary, PageResult } from "./types.js";

/** Who a recorded span belongs to, in the order the spans were recorded. */
type SpanOwner = { kind: "load" } | { kind: "action"; action: ActionResult };

/**
 * How long `finish()` may take before the page is given up on. It reads the
 * page a handful of times; on a page whose main thread never yields, each of
 * those reads would wait forever, and a crawl must not hang on measurement.
 */
const FINISH_TIMEOUT_MS = 15_000;

export class PagePerf {
  private loadHandle: SpanHandle | null = null;
  private readonly openActions = new Set<SpanHandle>();
  private readonly owners: SpanOwner[] = [];

  private constructor(
    private readonly session: PerfSession,
    private readonly client: CDPSession,
    private readonly url: string,
    private readonly opts: ResolvedPerfOptions,
    private readonly slug: string,
  ) {}

  /**
   * Open a lightbringer session on `page`. `installCollector` is false when
   * the crawler already installed the collector at context level — ahead of
   * the runtime-fault script, which is what keeps a `clock-skew` fault from
   * reaching the clock it captures. On the `testPage()` path the crawler owns
   * no context, so the collector goes onto the page instead.
   *
   * CPU and network throttling are never passed: the crawler owns both
   * (`faults.cpu()`, `network`), and lightbringer applying its own would
   * overwrite them on the same CDP session.
   */
  static async open(
    page: Page,
    url: string,
    opts: ResolvedPerfOptions,
    {
      pageIndex,
      runId,
      installCollector,
    }: { pageIndex: number; runId: string; installCollector: boolean },
  ): Promise<PagePerf> {
    const slug = perfSlug(url, pageIndex, runId);
    let tracePath: string | undefined;
    if (opts.level === "trace" && opts.outDir) {
      mkdirSync(opts.outDir, { recursive: true });
      tracePath = join(opts.outDir, `${slug}.trace.json`);
    }
    const client = await pageCdp(page.context(), page).session();
    const session = await startSession(page, client, {
      installCollector,
      trace: tracePath !== undefined,
      ...(tracePath !== undefined ? { tracePath } : {}),
      memGc: opts.memGc,
      coverage: opts.coverage,
      cssStats: opts.cssSelectorStats,
    });
    return new PagePerf(session, client, url, opts, slug);
  }

  /** Open the page-load span. Call right before `page.goto`. */
  async beginLoad(): Promise<void> {
    if (this.loadHandle) return;
    this.loadHandle = await this.session.controller.begin(loadSpanName(this.url));
  }

  /**
   * Close the page-load span. `settle: false` because the crawler has already
   * waited for `networkidle` and run its `afterLoad` work; the span ends now.
   */
  async endLoad(): Promise<void> {
    const handle = this.loadHandle;
    if (!handle) return;
    this.loadHandle = null;
    await this.record(handle, { kind: "load" });
  }

  /** Open an action span. The name is provisional; `finish()` names it from the result. */
  async beginAction(): Promise<SpanHandle> {
    const handle = await this.session.controller.begin("action");
    this.openActions.add(handle);
    return handle;
  }

  /** Close an action span and tie it to the result the action produced. */
  async endAction(handle: SpanHandle, action: ActionResult): Promise<void> {
    if (!this.openActions.delete(handle)) return;
    await this.record(handle, { kind: "action", action });
  }

  /** Drop an action span without recording it — the action was skipped. */
  cancelAction(handle: SpanHandle): void {
    if (!this.openActions.delete(handle)) return;
    this.session.controller.cancel(handle);
  }

  /**
   * Build the page's report and attach it: the load span to `result.perf`,
   * page extras to `result.perfPage`, and each action span to the
   * `ActionResult` it measured — the same objects the crawler already pushed
   * into its report, mutated in place.
   *
   * A load span still open (the `goto` threw) is closed first, so a timed-out
   * navigation still reports what it cost. Action spans still open belong to
   * actions that never produced a result; they are dropped.
   *
   * `navigationFailed` stops the page's pending load first, and the crawler
   * passes it only when the `goto` itself did not return: stopping the load
   * of a page that did load would abort its in-flight fetches, which only a
   * perf run would do. After a `goto`
   * that timed out on a document request nobody answers, the navigation is
   * still in flight, and Playwright holds every `page.evaluate` until the new
   * document's context exists — which is never. Measured: each of the
   * handful of reads `finish()` makes then waits until Chromium gives up on
   * the request, two minutes per page. `Page.stopLoading` is the browser's
   * stop button; the old document's context answers at once.
   */
  async finish(result: PageResult, { navigationFailed = false } = {}): Promise<void> {
    if (navigationFailed) await this.client.send("Page.stopLoading").catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), FINISH_TIMEOUT_MS);
    });
    const outcome = await Promise.race([this.build(result), timeout]).finally(() =>
      clearTimeout(timer),
    );
    if (outcome === "timeout") throw new Error(`perf finish timed out after ${FINISH_TIMEOUT_MS}ms`);
  }

  private async build(result: PageResult): Promise<void> {
    if (this.loadHandle) await this.endLoad();
    for (const handle of this.openActions) this.session.controller.cancel(handle);
    this.openActions.clear();

    const { report, covArtifact } = await this.session.finish(loadSpanName(this.url));

    // `report.spans` is in the order the spans were recorded, which is the
    // order `record()` pushed their owners.
    const sidecarSpans = report.spans.map((span, i) => {
      const owner = this.owners[i];
      if (!owner) return span;
      const kind = owner.kind === "load" ? "load" : actionKind(owner.action);
      const name = owner.kind === "load" ? loadSpanName(this.url) : kind;
      const key = perfKey(this.url, kind);
      const trimmed = toPerfSpanReport(span, key, name);
      if (owner.kind === "load") result.perf = trimmed;
      else owner.action.perf = trimmed;
      return { ...span, name, key };
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
  }

  /**
   * End a span and remember its owner — but only if lightbringer really
   * recorded it. `end()` of a handle it no longer knows is a no-op, and an
   * owner pushed for a span that was never recorded would shift every later
   * span onto the wrong result.
   */
  private async record(handle: SpanHandle, owner: SpanOwner): Promise<void> {
    const before = this.session.controller.spans.length;
    await this.session.controller.end(handle, { settle: false });
    if (this.session.controller.spans.length > before) this.owners.push(owner);
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
