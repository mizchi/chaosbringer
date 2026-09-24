/**
 * Synthetic perf spans and crawl reports for unit tests. Excluded from the
 * build (tsconfig: *.test-helpers.ts); only *.test.ts files import it.
 */
import type { ActionResult, CrawlReport, PageResult, PerfSpanReport } from "./types.js";

export interface SpanShape {
  durationMs?: number;
  blockingMs?: number;
  interactionMs?: number;
  requestCount?: number;
  encodedKB?: number;
  initiators?: { frame: string; requestCount: number; encodedKB: number }[];
  thirdParty?: { domain: string; requestCount: number; encodedKB: number; busyMs: number }[];
  faults?: string[];
  memory?: Partial<PerfSpanReport["memory"]>;
}

/** A span with every required field, the named ones set and the rest 0. */
export function fakeSpan(key: string, o: SpanShape = {}): PerfSpanReport {
  return {
    name: key,
    key,
    durationMs: o.durationMs ?? 10,
    capped: false,
    traceWindowUs: [0, 0],
    network: {
      requestCount: o.requestCount ?? 0,
      encodedKB: o.encodedKB ?? 0,
      busyMs: 0,
      waves: 0,
      thirdParty: {
        requestCount: 0,
        encodedKB: 0,
        busyMs: 0,
        byDomain: o.thirdParty ?? [],
      },
      byInitiator: (o.initiators ?? []).map((i) => ({ ...i, type: "script" })),
      requests: [],
    },
    cpu: {
      longTaskCount: 0,
      blockingMs: o.blockingMs ?? 0,
      maxLongTaskMs: 0,
    } as PerfSpanReport["cpu"],
    render: {
      scriptMs: 0,
      layoutCount: 0,
      layoutMs: 0,
      recalcStyleCount: 0,
      recalcStyleMs: 0,
      nodes: 0,
    } as PerfSpanReport["render"],
    memory: (o.memory ?? {}) as PerfSpanReport["memory"],
    ...(o.faults ? { faults: o.faults } : {}),
    ...(o.interactionMs !== undefined
      ? { interaction: { maxDurationMs: o.interactionMs } as PerfSpanReport["interaction"] }
      : {}),
  } as PerfSpanReport;
}

export function fakePage(url: string, load?: PerfSpanReport, extra: Partial<PageResult> = {}): PageResult {
  return {
    url,
    status: "success",
    loadTime: 0,
    errors: [],
    hasErrors: false,
    warnings: [],
    links: [],
    ...(load ? { perf: load } : {}),
    ...extra,
  };
}

export function fakeAction(perf?: PerfSpanReport): ActionResult {
  return { type: "click", success: true, timestamp: 0, ...(perf ? { perf } : {}) };
}

export function fakeReport(pages: PageResult[], actions: ActionResult[], extra: Partial<CrawlReport> = {}): CrawlReport {
  return {
    baseUrl: "http://localhost:3000",
    seed: 1,
    reproCommand: "chaosbringer",
    startTime: 0,
    endTime: 0,
    duration: 0,
    pagesVisited: pages.length,
    totalErrors: 0,
    totalWarnings: 0,
    blockedExternalNavigations: 0,
    recoveryCount: 0,
    pages,
    actions,
    summary: {
      successPages: 0,
      errorPages: 0,
      timeoutPages: 0,
      recoveredPages: 0,
      pagesWithErrors: 0,
      consoleErrors: 0,
      networkErrors: 0,
      jsExceptions: 0,
      unhandledRejections: 0,
      invariantViolations: 0,
      avgLoadTime: 0,
    },
    errorClusters: [],
    ...extra,
  };
}

/** One crawl of `/app`: its load and one click, with the click's cost given. */
export function appRun(click: SpanShape, load: SpanShape = {}): CrawlReport {
  return fakeReport(
    [fakePage("http://localhost:3000/app", fakeSpan("/app :: load", load))],
    [fakeAction(fakeSpan("/app :: click #go", click))],
  );
}
