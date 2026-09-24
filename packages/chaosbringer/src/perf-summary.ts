/**
 * `CrawlReport.perf`: the crawl-wide view of the per-step measurements.
 *
 * Pure, and built only from what is already in the report — the spans on
 * `PageResult.perf` / `ActionResult.perf` and the vitals on
 * `PageResult.perfPage` — so `generateReport` and `mergeReports` (shards)
 * produce the same summary from the same pages, and a unit test needs no
 * browser.
 */

import { percentile } from "lightbringer/core";
import type {
  ActionResult,
  CrawlPerfSummary,
  CrawlVitalSummary,
  PageResult,
  PerfSpanReport,
} from "./types.js";

/** The vitals the summary reports, in print order. */
export const SUMMARY_VITALS = ["LCP", "INP", "CLS", "TTFB", "FCP"] as const;

/** How many rows each list in the summary keeps. */
export const PERF_SUMMARY_TOP_N = 10;

/** Round to one decimal, the precision lightbringer reports in. */
const round1 = (n: number) => Math.round(n * 10) / 10;

/** One "slowest action" row. */
export interface SlowActionRow {
  key: string;
  durationMs: number;
  blockingMs: number;
  /** Absent when the span contained no interaction. */
  interactionMs?: number;
}

/** The `n` measured actions with the longest spans, slowest first. */
export function slowestActions(actions: readonly ActionResult[], n = 5): SlowActionRow[] {
  const rows: SlowActionRow[] = [];
  for (const a of actions) {
    if (!a.perf) continue;
    rows.push({
      key: a.perf.key,
      durationMs: a.perf.durationMs,
      blockingMs: a.perf.cpu.blockingMs,
      ...(a.perf.interaction ? { interactionMs: a.perf.interaction.maxDurationMs } : {}),
    });
  }
  return rows.sort((a, b) => b.durationMs - a.durationMs).slice(0, n);
}

/**
 * p50 / p75 / worst of each vital over the pages that reported it. Every
 * vital is lower-is-better, so "worst" is the largest value, with the page
 * it came from. A vital no page reported is absent, not 0.
 */
function vitalSummaries(pages: readonly PageResult[]): Record<string, CrawlVitalSummary> {
  const out: Record<string, CrawlVitalSummary> = {};
  for (const name of SUMMARY_VITALS) {
    const samples: { value: number; url: string }[] = [];
    for (const p of pages) {
      const v = p.perfPage?.vitals[name]?.value;
      if (typeof v === "number" && Number.isFinite(v)) samples.push({ value: v, url: p.url });
    }
    if (samples.length === 0) continue;
    // Both percentiles nearest-rank (lightbringer's `percentile`), so p50 and
    // p75 are values some page really had. lightbringer's `median` is not
    // used because it rounds to 0.1, which would turn every CLS into 0 or 0.1.
    const sorted = samples.map((s) => s.value).sort((a, b) => a - b);
    // First page wins a tie, so the worst page is stable across reruns.
    const worst = samples.reduce((w, s) => (s.value > w.value ? s : w));
    // CLS is a unitless score in the thousandths; rounding it to 0.1 like
    // the millisecond vitals would erase it.
    const r = name === "CLS" ? (n: number) => Math.round(n * 1000) / 1000 : round1;
    out[name] = {
      p50: r(percentile(sorted, 0.5)),
      p75: r(percentile(sorted, 0.75)),
      worst: { value: r(worst.value), url: worst.url },
    };
  }
  return out;
}

/** Sum `rows` into `into` by `key`, keeping first-seen order for ties. */
function addUp<T extends Record<string, number | string>>(
  into: Map<string, T>,
  key: string,
  row: T,
  numericFields: readonly (keyof T)[],
): void {
  const cur = into.get(key);
  if (!cur) {
    into.set(key, { ...row });
    return;
  }
  for (const f of numericFields) (cur[f] as number) += row[f] as number;
}

/**
 * Build `CrawlReport.perf`, or undefined when nothing was measured (a crawl
 * without `perf` must not grow an empty block).
 */
export function buildCrawlPerfSummary(
  pages: readonly PageResult[],
  actions: readonly ActionResult[],
): CrawlPerfSummary | undefined {
  const spans: PerfSpanReport[] = [];
  for (const p of pages) if (p.perf) spans.push(p.perf);
  for (const a of actions) if (a.perf) spans.push(a.perf);
  const measuredPages = pages.filter((p) => p.perf || p.perfPage).length;
  if (spans.length === 0 && measuredPages === 0) return undefined;

  const initiators = new Map<string, { frame: string; requestCount: number; encodedKB: number }>();
  const domains = new Map<
    string,
    { domain: string; requestCount: number; encodedKB: number; busyMs: number }
  >();
  for (const s of spans) {
    for (const i of s.network.byInitiator ?? []) {
      addUp(initiators, i.frame, { frame: i.frame, requestCount: i.requestCount, encodedKB: i.encodedKB }, [
        "requestCount",
        "encodedKB",
      ]);
    }
    for (const d of s.network.thirdParty?.byDomain ?? []) {
      addUp(
        domains,
        d.domain,
        { domain: d.domain, requestCount: d.requestCount, encodedKB: d.encodedKB, busyMs: d.busyMs },
        ["requestCount", "encodedKB", "busyMs"],
      );
    }
  }

  const hotInitiators = [...initiators.values()]
    .sort((a, b) => b.requestCount - a.requestCount || b.encodedKB - a.encodedKB)
    .slice(0, PERF_SUMMARY_TOP_N)
    .map((i) => ({ ...i, encodedKB: round1(i.encodedKB) }));
  const thirdParty = [...domains.values()]
    .sort((a, b) => b.encodedKB - a.encodedKB || b.requestCount - a.requestCount)
    .slice(0, PERF_SUMMARY_TOP_N)
    .map((d) => ({ ...d, encodedKB: round1(d.encodedKB), busyMs: round1(d.busyMs) }));

  return {
    vitals: vitalSummaries(pages),
    slowestActions: slowestActions(actions, PERF_SUMMARY_TOP_N),
    hotInitiators,
    thirdParty,
    totals: { spans: spans.length, pages: measuredPages },
  };
}
