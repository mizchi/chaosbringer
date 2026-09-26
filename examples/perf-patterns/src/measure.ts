/**
 * Crawl each variant of a pattern N times at a fixed seed with `perf` on and
 * read the pattern's expected metric off the spans whose perfKey matches (or,
 * for a `page.` metric, off `perfPage` of the pages whose load key matches).
 */

import {
  chaos,
  compilePerfKeyGlob,
  type CrawlPerfSummary,
  type CrawlReport,
  type PerfDegradationEntry,
  type PerfSpanReport,
} from "chaosbringer";
import type { MetricExpect, Pattern, Variant } from "./pattern.js";
import { servePattern } from "./server.js";

export interface VariantMeasurement {
  variant: Variant;
  /** Median of the metric over every matching span (degradation entry, page) of every run; null when none matched. */
  median: number | null;
  /** Every value the median was taken over. */
  values: number[];
  /** How many values each run gave. */
  matchedPerRun: number[];
  /** The distinct perfKeys that matched `expect.key`. */
  matchedKeys: string[];
  /** Page routes visited, per run (urlPattern-like: pathname only). */
  pagesPerRun: string[][];
  /** Error-cluster keys (URL-free), per run. */
  clustersPerRun: string[][];
  /** `expect.alsoExpect`, in order: each metric's median and values over the same runs. */
  also: Array<{ metric: string; median: number | null; values: number[] }>;
  /** From the last run, for the report. */
  slowestActions: CrawlPerfSummary["slowestActions"];
  degradation: PerfDegradationEntry[];
  reports: CrawlReport[];
}

export interface Improvement {
  /** slow − fixed. */
  absolute: number | null;
  /** slow / fixed (Infinity when fixed is 0 and slow is not). */
  ratio: number | null;
  /** Whether every `minImprovement` bound holds. */
  ok: boolean;
}

export interface PatternMeasurement {
  pattern: Pattern;
  slow: VariantMeasurement;
  fixed: VariantMeasurement;
  improvement: Improvement;
  /** `expect.alsoExpect`, in order. */
  also: Array<{ expect: MetricExpect; slow: number | null; fixed: number | null; improvement: Improvement }>;
}

export interface MeasureOptions {
  runs?: number;
  headless?: boolean;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Read `a.b.c` off an object; `effectiveMs` is derived per span. */
export function readPath(obj: unknown, path: string): number | undefined {
  if (path === "effectiveMs") {
    const span = obj as PerfSpanReport;
    return Math.max(span.durationMs, span.network?.settledMs ?? 0);
  }
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return typeof cur === "number" && Number.isFinite(cur) ? cur : undefined;
}

export function spansOf(report: CrawlReport): PerfSpanReport[] {
  const spans: PerfSpanReport[] = [];
  for (const p of report.pages) if (p.perf) spans.push(p.perf);
  for (const a of report.actions) if (a.perf) spans.push(a.perf);
  return spans;
}

/**
 * The metric's values in one report: one per matching span, per matching
 * degradation entry, or (`page.` metrics) per page whose load span's key
 * matches, read off its `perfPage`. `absentAs` stands in for a `page.` field
 * a measured page left out (not for a page whose collector never ran).
 */
export function metricValues(
  report: CrawlReport,
  keyGlob: string,
  metric: string,
  absentAs?: number,
): { values: number[]; keys: string[] } {
  const re = compilePerfKeyGlob(keyGlob);
  const values: number[] = [];
  const keys = new Set<string>();
  if (metric.startsWith("page.")) {
    const path = metric.slice("page.".length);
    for (const p of report.pages) {
      const key = p.perf?.key;
      if (!key || !p.perfPage || !re.test(key)) continue;
      keys.add(key);
      const v = readPath(p.perfPage, path) ?? (p.perfPage.collectorMissing ? undefined : absentAs);
      if (v !== undefined) values.push(v);
    }
  } else if (metric.startsWith("degradation.")) {
    const path = metric.slice("degradation.".length);
    for (const entry of report.perf?.degradation ?? []) {
      if (!re.test(entry.key)) continue;
      const v = readPath(entry, path);
      if (v !== undefined) {
        values.push(v);
        keys.add(entry.key);
      }
    }
  } else {
    for (const span of spansOf(report)) {
      if (!re.test(span.key)) continue;
      keys.add(span.key);
      const v = readPath(span, metric);
      if (v !== undefined) values.push(v);
    }
  }
  return { values, keys: [...keys].sort() };
}

function routeOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export async function measureVariant(
  pattern: Pattern,
  variant: Variant,
  { runs = 3, headless = true }: MeasureOptions = {},
): Promise<VariantMeasurement> {
  const server = await servePattern(pattern, variant);
  const c = pattern.crawl;
  const values: number[] = [];
  const also = (pattern.expect.alsoExpect ?? []).map((e) => ({ metric: e.metric, values: [] as number[] }));
  const matchedPerRun: number[] = [];
  const matchedKeys = new Set<string>();
  const pagesPerRun: string[][] = [];
  const clustersPerRun: string[][] = [];
  const reports: CrawlReport[] = [];
  try {
    for (let i = 0; i < runs; i++) {
      const { report } = await chaos({
        baseUrl: server.origin + (c.entry ?? "/"),
        seed: c.seed,
        maxPages: c.maxPages,
        maxActionsPerPage: c.maxActionsPerPage,
        settle: c.settle ?? "adaptive",
        perf: c.perf ?? true,
        headless,
        ...(c.faults ? { faultInjection: c.faults } : {}),
        ...(c.actionWeights ? { actionWeights: c.actionWeights } : {}),
        ...(c.driver ? { driver: c.driver } : {}),
        ...c.options,
      });
      reports.push(report);
      const m = metricValues(report, pattern.expect.key, pattern.expect.metric, pattern.expect.absentAs);
      for (const [i, e] of (pattern.expect.alsoExpect ?? []).entries()) {
        also[i]!.values.push(...metricValues(report, pattern.expect.key, e.metric, e.absentAs).values);
      }
      values.push(...m.values);
      matchedPerRun.push(m.values.length);
      for (const k of m.keys) matchedKeys.add(k);
      pagesPerRun.push([...new Set(report.pages.map((p) => routeOf(p.url)))].sort());
      clustersPerRun.push(report.errorClusters.map((cl) => cl.key).sort());
    }
  } finally {
    await server.close();
  }
  const last = reports[reports.length - 1];
  return {
    variant,
    median: median(values),
    values,
    matchedPerRun,
    matchedKeys: [...matchedKeys].sort(),
    pagesPerRun,
    clustersPerRun,
    also: also.map((a) => ({ ...a, median: median(a.values) })),
    slowestActions: last?.perf?.slowestActions ?? [],
    degradation: last?.perf?.degradation ?? [],
    reports,
  };
}

export function improvementOf(expect: Pick<MetricExpect, "minImprovement">, slow: number | null, fixed: number | null): Improvement {
  if (slow === null || fixed === null) return { absolute: null, ratio: null, ok: false };
  const absolute = slow - fixed;
  const ratio = fixed === 0 ? (slow === 0 ? 1 : Number.POSITIVE_INFINITY) : slow / fixed;
  const { ratio: minRatio, absolute: minAbs } = expect.minImprovement;
  const ok = (minRatio === undefined || ratio >= minRatio) && (minAbs === undefined || absolute >= minAbs);
  return { absolute, ratio, ok };
}

export async function measurePattern(pattern: Pattern, opts: MeasureOptions = {}): Promise<PatternMeasurement> {
  const slow = await measureVariant(pattern, "slow", opts);
  const fixed = await measureVariant(pattern, "fixed", opts);
  const also = (pattern.expect.alsoExpect ?? []).map((expect, i) => {
    const s = slow.also[i]!.median;
    const f = fixed.also[i]!.median;
    return { expect, slow: s, fixed: f, improvement: improvementOf(expect, s, f) };
  });
  return { pattern, slow, fixed, improvement: improvementOf(pattern.expect, slow.median, fixed.median), also };
}
