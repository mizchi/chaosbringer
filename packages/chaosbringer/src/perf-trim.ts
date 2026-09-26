/**
 * Trimming lightbringer spans down to what the crawl report, the model prompt
 * and the per-step cost rows carry. Pure, so the report size rules are
 * unit-testable without a browser.
 */

import type { PerfReport, SpanReport } from "lightbringer/core";
import type { LastActionPerf, PagePerfSummary, PerfSpanReport } from "./types.js";

/**
 * The three numbers a span's cost is compared by: wall time, main-thread
 * blocking, and — only when the span contained one — the slowest interaction.
 */
export function spanCost(span: Pick<SpanReport, "durationMs" | "cpu" | "interaction">): {
  durationMs: number;
  blockingMs: number;
  interactionMs?: number;
} {
  return {
    durationMs: span.durationMs,
    blockingMs: span.cpu.blockingMs,
    ...(span.interaction ? { interactionMs: span.interaction.maxDurationMs } : {}),
  };
}

/** How many entries each per-span list keeps in the crawl report. */
export const PERF_REPORT_LIST_CAP = 5;

/**
 * A lightbringer span as it goes into the crawl report: keyed, renamed, and
 * with its per-request lists capped.
 *
 * lightbringer keeps up to 20 requests per span. On a 500-page crawl with
 * five actions a page that is most of the report, so the report keeps the
 * top five of each list (lightbringer sorts requests slowest first and
 * initiators / domains heaviest first) and the full
 * span stays in the per-page sidecar under `outDir`. The totals —
 * `requestCount`, `encodedKB` — are computed before trimming and still count
 * everything. The declared `budget` is dropped: the crawler declares none.
 */
export function toPerfSpanReport(span: SpanReport, key: string, name: string): PerfSpanReport {
  const { budget: _budget, ...rest } = span;
  void _budget;
  const network = span.network;
  return {
    ...rest,
    name,
    key,
    network: {
      ...network,
      requests: network.requests.slice(0, PERF_REPORT_LIST_CAP),
      byInitiator: network.byInitiator.slice(0, PERF_REPORT_LIST_CAP),
      thirdParty: {
        ...network.thirdParty,
        byDomain: network.thirdParty.byDomain.slice(0, PERF_REPORT_LIST_CAP),
      },
    },
  };
}

/** Trim a span to the facts `LastActionPerf` carries. */
export function toLastActionPerf(span: SpanReport, key: string): LastActionPerf {
  return {
    key,
    durationMs: span.durationMs,
    cpu: { blockingMs: span.cpu.blockingMs, longTaskCount: span.cpu.longTaskCount },
    ...(span.interaction ? { interaction: span.interaction } : {}),
    network: { requestCount: span.network.requestCount, encodedKB: span.network.encodedKB },
  };
}

/**
 * The one line a model prompt gets about the previous action's cost. No key:
 * it holds the selector, which never goes to a model, and the history line
 * right above it already says which action this was.
 */
export function formatLastActionPerf(p: Omit<LastActionPerf, "key">): string {
  const parts = [
    `${p.durationMs}ms`,
    `${p.cpu.blockingMs}ms main-thread blocking over ${p.cpu.longTaskCount} long task${p.cpu.longTaskCount === 1 ? "" : "s"}`,
  ];
  if (p.interaction) parts.push(`${p.interaction.maxDurationMs}ms interaction latency`);
  parts.push(`${p.network.requestCount} request${p.network.requestCount === 1 ? "" : "s"} (${p.network.encodedKB} KB)`);
  return `Previous action cost: ${parts.join(", ")}`;
}

/** How many entries each `PagePerfSummary` list (`media.oversized`, `renderBlocking.urls`, ...) keeps. */
export const PERF_PAGE_LIST_CAP = 3;

/**
 * The page-level slice of a lightbringer report that goes into the crawl
 * report (`PageResult.perfPage`). Lists are cut to `PERF_PAGE_LIST_CAP`; the
 * counts beside them count everything. A part lightbringer did not report —
 * no third-party request, no image, nothing render-blocking — stays absent
 * rather than reading 0.
 */
export function toPagePerfSummary(report: PerfReport): PagePerfSummary {
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
  const media = report.media;
  if (media && (media.imageCount > 0 || media.oversized.length > 0 || media.uncompressed.length > 0)) {
    summary.media = {
      imageCount: media.imageCount,
      imageKB: media.imageKB,
      oversizedCount: media.oversizedCount ?? media.oversized.length,
      oversized: media.oversized
        .slice(0, PERF_PAGE_LIST_CAP)
        .map(({ url, overFetch, kb }) => ({ url, overFetch, kb })),
      uncompressedCount: media.uncompressedCount ?? media.uncompressed.length,
      uncompressed: media.uncompressed
        .slice(0, PERF_PAGE_LIST_CAP)
        .map(({ url, kb, ratio }) => ({ url, kb, ratio })),
    };
  }
  const rb = report.renderBlocking;
  if (rb && (rb.stylesheets.length > 0 || rb.scripts.length > 0)) {
    summary.renderBlocking = {
      stylesheets: rb.stylesheets.length,
      scripts: rb.scripts.length,
      urls: [...rb.stylesheets, ...rb.scripts].slice(0, PERF_PAGE_LIST_CAP),
    };
  }
  if (report.clockPatched) summary.clockPatched = true;
  if (report.collectorMissing) summary.collectorMissing = true;
  return summary;
}
