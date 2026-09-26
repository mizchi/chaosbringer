/**
 * Crawl each variant of a pattern N times at a fixed seed with `perf` on and
 * read the pattern's expected metric off the spans whose perfKey matches.
 */

import {
  chaos,
  compilePerfKeyGlob,
  type CrawlPerfSummary,
  type CrawlReport,
  type PerfDegradationEntry,
  type PerfSpanReport,
} from "chaosbringer";
import type { Pattern, Variant } from "./pattern.js";
import { servePattern } from "./server.js";

export interface VariantMeasurement {
  variant: Variant;
  /** Median of the metric over every matching span (or degradation entry) of every run; null when none matched. */
  median: number | null;
  /** Every value the median was taken over. */
  values: number[];
  /** How many matching spans (or degradation entries) each run had. */
  matchedPerRun: number[];
  /** The distinct perfKeys that matched `expect.key`. */
  matchedKeys: string[];
  /** Page routes visited, per run (urlPattern-like: pathname only). */
  pagesPerRun: string[][];
  /** Error-cluster keys (URL-free), per run. */
  clustersPerRun: string[][];
  /** From the last run, for the report. */
  slowestActions: CrawlPerfSummary["slowestActions"];
  degradation: PerfDegradationEntry[];
  reports: CrawlReport[];
}

export interface PatternMeasurement {
  pattern: Pattern;
  slow: VariantMeasurement;
  fixed: VariantMeasurement;
  improvement: {
    /** slow − fixed. */
    absolute: number | null;
    /** slow / fixed (Infinity when fixed is 0 and slow is not). */
    ratio: number | null;
    /** Whether every `minImprovement` bound holds. */
    ok: boolean;
  };
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

/** The metric's values in one report: one per matching span, or per matching degradation entry. */
export function metricValues(report: CrawlReport, keyGlob: string, metric: string): { values: number[]; keys: string[] } {
  const re = compilePerfKeyGlob(keyGlob);
  const values: number[] = [];
  const keys = new Set<string>();
  if (metric.startsWith("degradation.")) {
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
      const m = metricValues(report, pattern.expect.key, pattern.expect.metric);
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
    slowestActions: last?.perf?.slowestActions ?? [],
    degradation: last?.perf?.degradation ?? [],
    reports,
  };
}

export function improvementOf(
  pattern: Pattern,
  slow: number | null,
  fixed: number | null,
): PatternMeasurement["improvement"] {
  if (slow === null || fixed === null) return { absolute: null, ratio: null, ok: false };
  const absolute = slow - fixed;
  const ratio = fixed === 0 ? (slow === 0 ? 1 : Number.POSITIVE_INFINITY) : slow / fixed;
  const { ratio: minRatio, absolute: minAbs } = pattern.expect.minImprovement;
  const ok = (minRatio === undefined || ratio >= minRatio) && (minAbs === undefined || absolute >= minAbs);
  return { absolute, ratio, ok };
}

export async function measurePattern(pattern: Pattern, opts: MeasureOptions = {}): Promise<PatternMeasurement> {
  const slow = await measureVariant(pattern, "slow", opts);
  const fixed = await measureVariant(pattern, "fixed", opts);
  return { pattern, slow, fixed, improvement: improvementOf(pattern, slow.median, fixed.median) };
}
