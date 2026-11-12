/**
 * Crawl each variant of a pattern N times at a fixed seed with `perf` on and
 * read the pattern's expected metric off the spans whose perfKey matches (or,
 * for a `page.` metric, off `perfPage` of the pages whose load key matches).
 */

import { statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  chaos,
  compilePerfKeyGlob,
  type CrawlerOptions,
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
  /** Per run: why it gave no value (`missingValueReason`), or undefined when it gave some. */
  missingPerRun: Array<string | undefined>;
  /** `report.warnings` codes, per run. */
  warningsPerRun: string[][];
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
 * matches, read off its `perfPage`. `absentAs` stands in for a field a
 * measured page left out (not for a page whose collector never ran) or a
 * matching span left out (`interaction` when no event passed the 16 ms
 * Event Timing threshold); degradation entries ignore it.
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
      const v = readPath(span, metric) ?? absentAs;
      if (v !== undefined) values.push(v);
    }
  }
  return { values, keys: [...keys].sort() };
}

const dash = (v: number | undefined): string => (v === undefined ? "–" : String(v));

/**
 * Why `metricValues` gave nothing for this report, in one line, for the
 * assertion text: CI keeps no report JSON, and "no value" has causes that
 * want different fixes (a crawl that never reached the key, a perf session
 * that failed, a collector that never ran, a browser that had not reported
 * the vital yet). Matching pages or entries with different causes get one
 * reason each, joined by " | ".
 */
export function missingValueReason(report: CrawlReport, keyGlob: string, metric: string): string {
  const re = compilePerfKeyGlob(keyGlob);
  const keyList = (keys: Iterable<string>) => [...new Set(keys)].sort().join(", ") || "none";
  const reasons = new Set<string>();
  if (metric.startsWith("page.")) {
    const path = metric.slice("page.".length);
    const pages = report.pages.filter((p) => p.perf?.key && re.test(p.perf.key));
    if (pages.length === 0) {
      return `no page with load key matching ${keyGlob} (keys: ${keyList(report.pages.flatMap((p) => (p.perf?.key ? [p.perf.key] : [])))})`;
    }
    for (const p of pages) {
      if (!p.perfPage) {
        const warnings = (report.warnings ?? []).map((w) => `${w.code}: ${w.message}`);
        reasons.add(`no perfPage (${warnings.length ? `warnings: ${warnings.join("; ")}` : "no warnings"})`);
      } else if (p.perfPage.collectorMissing) {
        reasons.add("collectorMissing");
      } else if (readPath(p.perfPage, path) === undefined) {
        reasons.add(
          `${path} absent; vitals has [${Object.keys(p.perfPage.vitals ?? {}).join(",")}]; ` +
            `raw metrics fcp=${dash(p.metrics?.fcp)} lcp=${dash(p.metrics?.lcp)}; settleCapped=${dash(p.settleCapped)}`,
        );
      }
    }
  } else if (metric.startsWith("degradation.")) {
    const path = metric.slice("degradation.".length);
    const entries = report.perf?.degradation ?? [];
    const matched = entries.filter((e) => re.test(e.key));
    if (matched.length === 0) return `no degradation entry matched ${keyGlob} (keys: ${keyList(entries.map((e) => e.key))})`;
    for (const e of matched) if (readPath(e, path) === undefined) reasons.add(`${path} absent on ${e.key} [${e.fault}]`);
  } else {
    const spans = spansOf(report);
    const matched = spans.filter((s) => re.test(s.key));
    if (matched.length === 0) return `no span matched ${keyGlob} (keys: ${keyList(spans.map((s) => s.key))})`;
    for (const s of matched) if (readPath(s, metric) === undefined) reasons.add(`${metric} absent on ${s.key}`);
  }
  return [...reasons].join(" | ") || "every match has a value";
}

/**
 * Where the harness's Chromium keeps its shared memory.
 *
 * Playwright launches Chromium with --disable-dev-shm-usage, so that it
 * survives Docker's 64 MB /dev/shm. Chromium then creates every POSIX
 * shared-memory region (the data pipe of each response body, shared bitmaps)
 * as a file in $TMPDIR. Where $TMPDIR is on a journaled disk that background
 * writeback keeps busy (a CI runner's /tmp right after a cache restore), each
 * create, unlink, fallocate and mmap of those files on the network, IO,
 * renderer and viz threads waits on the journal for 50-200 ms. That put
 * +60..+500 ms on top of FCP, LCP and settledMs in bursts, which is how fixed
 * variants missed their thresholds. Desktop Chrome keeps shared memory in
 * /dev/shm, so where /dev/shm is a tmpfs with room the harness drops the flag:
 * the pages, servers, thresholds and runs stay the same, and the measurement
 * stops depending on disk activity. `line` says which mode measured, and
 * which filesystems /dev/shm and $TMPDIR are, for the CI log.
 *
 * `setting` is PERF_PATTERN_SHM: unset (or empty) chooses as above, `tmp`
 * keeps Playwright's default (for A/B runs).
 */
export interface ChromiumShm {
  devShm: boolean;
  line: string;
}

interface StatFs {
  type: number;
  bavail: number;
  bsize: number;
}

const TMPFS_MAGIC = 0x01021994;
const FS_NAMES: Record<number, string> = {
  [TMPFS_MAGIC]: "tmpfs",
  0xef53: "ext4",
  0x58465342: "xfs",
  0x9123683e: "btrfs",
  0x794c7630: "overlayfs",
};
const MIN_DEV_SHM_BYTES = 512 * 1024 ** 2;

export function chooseChromiumShm({
  platform,
  setting,
  tmpdir,
  statfs,
}: {
  platform: NodeJS.Platform;
  setting: string | undefined;
  tmpdir: string;
  statfs: (path: string) => StatFs;
}): ChromiumShm {
  if (setting !== undefined && setting !== "" && setting !== "tmp") {
    throw new Error(`PERF_PATTERN_SHM must be unset or "tmp" (keep Playwright's shared memory in $TMPDIR), got ${JSON.stringify(setting)}`);
  }
  const probe = (path: string): StatFs | undefined => {
    try {
      return statfs(path);
    } catch {
      return undefined;
    }
  };
  const describe = (path: string, st: StatFs | undefined) =>
    st
      ? `${path} is ${FS_NAMES[st.type] ?? `fs 0x${st.type.toString(16)}`} (${((st.bavail * st.bsize) / 1024 ** 3).toFixed(1)} GiB free)`
      : `${path} is unreadable`;
  const shm = probe("/dev/shm");
  const why =
    setting === "tmp"
      ? "PERF_PATTERN_SHM=tmp"
      : platform !== "linux"
        ? "not Linux"
        : !shm
          ? "/dev/shm unreadable"
          : shm.type !== TMPFS_MAGIC
            ? "/dev/shm is not tmpfs"
            : shm.bavail * shm.bsize < MIN_DEV_SHM_BYTES
              ? "/dev/shm under 512 MiB free"
              : undefined;
  const mode = why === undefined ? "/dev/shm" : `$TMPDIR (${why})`;
  return {
    devShm: why === undefined,
    line: `chromium shared memory: ${mode}; ${describe("/dev/shm", shm)}; ${describe(`$TMPDIR=${tmpdir}`, probe(tmpdir))}`,
  };
}

export const chromiumShm: ChromiumShm = chooseChromiumShm({
  platform: process.platform,
  setting: process.env.PERF_PATTERN_SHM,
  tmpdir: tmpdir(),
  statfs: (path) => statfsSync(path),
});

type LaunchOptions = NonNullable<CrawlerOptions["launchOptions"]>;

/** `launchOptions` without Playwright's --disable-dev-shm-usage (see `ChromiumShm`). */
export function withDevShm(launchOptions: LaunchOptions | undefined): LaunchOptions {
  const ignored = launchOptions?.ignoreDefaultArgs;
  return {
    ...launchOptions,
    ignoreDefaultArgs: ignored === true ? true : [...new Set([...(Array.isArray(ignored) ? ignored : []), "--disable-dev-shm-usage"])],
  };
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
  const missingPerRun: Array<string | undefined> = [];
  const warningsPerRun: string[][] = [];
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
        // After c.options, so a pattern's own launch args are kept.
        ...(chromiumShm.devShm ? { launchOptions: withDevShm(c.options?.launchOptions) } : {}),
      });
      reports.push(report);
      const m = metricValues(report, pattern.expect.key, pattern.expect.metric, pattern.expect.absentAs);
      for (const [i, e] of (pattern.expect.alsoExpect ?? []).entries()) {
        also[i]!.values.push(...metricValues(report, pattern.expect.key, e.metric, e.absentAs).values);
      }
      values.push(...m.values);
      matchedPerRun.push(m.values.length);
      missingPerRun.push(m.values.length ? undefined : missingValueReason(report, pattern.expect.key, pattern.expect.metric));
      warningsPerRun.push((report.warnings ?? []).map((w) => w.code));
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
    missingPerRun,
    warningsPerRun,
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
