/**
 * `CrawlReport.perf`: the crawl-wide view of the per-step measurements.
 *
 * Pure, and built only from what is already in the report — the spans on
 * `PageResult.perf` / `ActionResult.perf` and the vitals on
 * `PageResult.perfPage` — so `generateReport` and `mergeReports` (shards)
 * produce the same summary from the same pages, and a unit test needs no
 * browser. The one input that is not in the report is the crawl's coverage
 * union: byte ranges are too big for a report, so the crawler folds them as
 * it goes and hands the result in.
 */

import {
  buildTrends,
  percentile,
  unionCoverage,
  type CoverageArtifact,
  type CoverageUnionKind,
  type MemoryTrend,
} from "lightbringer/core";
import { buildDegradation } from "./perf-faults.js";
import type {
  ActionResult,
  CrawlCoverageKind,
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
 * Memory climbs across repeats of one step. A crawl has no `measureRepeat`,
 * but it repeats steps on its own: the same nav click on every page, the
 * same button clicked again. Spans sharing a perfKey, in crawl order, are
 * those repeats, so each is named `<key>#<i>` — the shape lightbringer's
 * `buildTrends` groups by — and its leak rules apply unchanged (at least
 * three repeats, sustained and distributed growth past each gauge's floor).
 *
 * Loads are in visit order (`pages`), actions in the order they ran
 * (`timestamp`, stable); one key is never both, since `load` is its kind. A
 * span without memory gauges (a collector that never answered) is skipped
 * rather than read as zero, which would fake a climb.
 *
 * So is a span that created a document (`documentsDelta > 0`: every load, a
 * click that navigates). The gauges are the renderer's totals, and the
 * documents a crawl leaves behind stay counted until a GC collects them, so
 * a run of navigations climbs on garbage alone: on the fixture site every
 * nav link repeated three times "leaked" ~34 listeners a step. What is left
 * is steps that stay on their document — a client-side nav, a button — where
 * a climb is retention.
 *
 * Dropping those spans is not enough on its own: the garbage they leave is
 * in the totals of every later span too. A button clicked between nav clicks
 * on one visit (the weighted loop keeps acting after a navigation, and every
 * action keeps the visit's key) climbs ~74 listeners per navigation with an
 * empty handler. So a key's repeats form one series only while no document
 * was created between them; any navigation starts a new series, and each is
 * judged on its own. A key can therefore appear more than once, one entry per
 * run that climbed. Loads carry no timestamp to place them among actions, so
 * a visit boundary with no navigating action on either side does not split a
 * run; each visit is a fresh tab, and a key only spans visits when two
 * visits share a URL pattern.
 */
export function buildPerfTrends(
  pages: readonly PageResult[],
  actions: readonly ActionResult[],
): MemoryTrend[] {
  const ordered: PerfSpanReport[] = [];
  for (const p of pages) if (p.perf) ordered.push(p.perf);
  const timed = actions.filter((a) => a.perf);
  timed.sort((a, b) => a.timestamp - b.timestamp);
  for (const a of timed) ordered.push(a.perf!);

  // `epoch` counts documents created so far; a key's run is broken when the
  // epoch moved since its last repeat.
  let epoch = 0;
  const runs = new Map<string, { epoch: number; run: Array<{ name: string; memory: PerfSpanReport["memory"] }> }>();
  const finished: Array<Array<{ name: string; memory: PerfSpanReport["memory"] }>> = [];
  for (const s of ordered) {
    if (s.memory && s.memory.documentsDelta > 0) {
      epoch++;
      continue;
    }
    if (!s.memory || !Number.isFinite(s.memory.jsEventListeners)) continue;
    let cur = runs.get(s.key);
    if (!cur || cur.epoch !== epoch) {
      if (cur) finished.push(cur.run);
      cur = { epoch, run: [] };
      runs.set(s.key, cur);
    }
    // `buildTrends` splits on the last `#<digits>`, so a key that already
    // holds a `#` (`click #save`) keeps it in the prefix.
    cur.run.push({ name: `${s.key}#${cur.run.length}`, memory: s.memory });
  }
  for (const { run } of runs.values()) finished.push(run);
  // One `buildTrends` call per run: runs of one key share a name, and one
  // call would merge them back into a single series.
  return finished.flatMap((run) => (run.length >= 3 ? buildTrends(run) : []));
}

/** How many resources each coverage kind lists. */
export const COVERAGE_LOW_USAGE_TOP_N = 10;

function coverageKind(u: CoverageUnionKind): CrawlCoverageKind {
  // `unionCoverage` already sorts rows heaviest-unused first.
  return {
    totalBytes: u.total,
    usedBytes: u.used,
    usedPct: u.pct,
    lowUsage: u.rows.slice(0, COVERAGE_LOW_USAGE_TOP_N).map((r) => ({
      url: r.url,
      totalBytes: r.total,
      usedBytes: r.used,
      usedPct: r.pct,
    })),
  };
}

/** `CrawlPerfSummary.coverage` from the crawl's merged coverage artifact. */
export function buildCoverageSummary(artifact: Partial<CoverageArtifact>): {
  js: CrawlCoverageKind;
  css: CrawlCoverageKind;
} {
  const u = unionCoverage([artifact]);
  return { js: coverageKind(u.js), css: coverageKind(u.css) };
}

/**
 * Build `CrawlReport.perf`, or undefined when nothing was measured (a crawl
 * without `perf` must not grow an empty block). `coverage` is the crawl's
 * merged coverage artifact, when `perf.coverage` produced one.
 */
export function buildCrawlPerfSummary(
  pages: readonly PageResult[],
  actions: readonly ActionResult[],
  { coverage }: { coverage?: Partial<CoverageArtifact> } = {},
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

  const degradation = buildDegradation(spans);
  const trends = buildPerfTrends(pages, actions);
  return {
    vitals: vitalSummaries(pages),
    slowestActions: slowestActions(actions, PERF_SUMMARY_TOP_N),
    hotInitiators,
    thirdParty,
    totals: { spans: spans.length, pages: measuredPages },
    ...(degradation.length > 0 ? { degradation } : {}),
    ...(trends.length > 0 ? { trends } : {}),
    ...(coverage ? { coverage: buildCoverageSummary(coverage) } : {}),
  };
}
