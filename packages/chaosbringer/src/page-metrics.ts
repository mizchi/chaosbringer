/**
 * Page-load metrics read by the crawler once a page's load has settled.
 */
import type { Page } from "playwright";
import type { PerfWindow } from "lightbringer/core";
import type { PerformanceMetrics } from "./types.js";

/**
 * Read the page-load metrics once the load has settled.
 *
 * TTFB / FCP / DCL / load come from Navigation and Paint Timing, as they
 * always have. LCP and TBT come from lightbringer's collector, which the
 * crawler installs at context level in `ChaosCrawler.start()`:
 *
 *   - `lcp` is web-vitals' latest LCP candidate. It exists only once the
 *     browser has reported one, which is why this runs after the load
 *     settles rather than at `domcontentloaded`.
 *   - `tbt` is Σ max(0, duration − 50 ms) over long tasks that started at
 *     or after FCP (from time 0 when there was no paint), up to now. Real
 *     TBT stops at Time to Interactive; the crawler has no TTI, so this is
 *     "FCP to the end of load" — an approximation, and documented as one.
 *
 * The collector is read without draining it. Long tasks come from its
 * `longTaskLog`, which no drain moves. With perf on, the perf session's emit
 * binding moves each task out of `longTasks` as soon as the observer reports
 * it, so `longTasks` alone read TBT 0. `flush()` first moves observer records
 * the browser has queued but not yet delivered, so a long task at the very
 * end of the load is not missed.
 *
 * A page without the collector — a caller-owned page on the `testPage()`
 * path, or `setContent` — keeps today's four fields and leaves `lcp` and
 * `tbt` absent. Absent, never 0: a 0 would pass every budget and read as
 * "measured, and fast".
 */
export async function collectLoadMetrics(page: Page): Promise<PerformanceMetrics> {
  return (await readLoadMetrics(page)).metrics;
}

/** A long task as the collector records it (this document's timeline). */
export interface LoadLongTask {
  start: number;
  duration: number;
}

/**
 * What the first read says about paints that may still be reported: entry-list
 * scans only (no DOM walk), so it costs what the read always did. It decides
 * whether the crawler checks for a paint drawn but not yet presented
 * (`paintCheckNeeded`), and why a budgeted metric is absent (`unmeasuredBudget`).
 */
export interface LoadPaintHint {
  /** `performance.timeOrigin`: a later read merges only from the same document. */
  timeOrigin: number;
  /** visible and not prerendering: a hidden document reports no paint */
  visible: boolean;
  /** lightbringer's collector is on the page (LCP and TBT come from it) */
  collector: boolean;
  /** web-vitals is loaded (the collector's FCP / LCP vitals come from it) */
  webVitals: boolean;
  /** the document was hidden at some point: web-vitals reports nothing after that */
  hiddenEntry: boolean;
  /** the collector holds web-vitals' FCP */
  fcpVital: boolean;
  /** image responses that finished after the current LCP candidate */
  lateImages: number;
  /** a first input happened: Chromium reports no LCP candidate after it */
  input: boolean;
}

/** `collectLoadMetrics` plus what a later read needs. */
export interface LoadMetricsRead {
  metrics: PerformanceMetrics;
  /**
   * The long tasks TBT was computed from (the document's log at the read), so
   * a later read that finds the FCP this one missed recomputes TBT from the
   * same tasks, and not from tasks that ran after the load. Null without the
   * collector.
   */
  longTasks: LoadLongTask[] | null;
  /** Null when the read failed. */
  paint: LoadPaintHint | null;
}

/**
 * The in-page read. Self-contained (Playwright serializes it), and named so
 * `perf drilldown` labels its samples as harness work.
 */
function chaosbringerLoadMetrics(): Omit<LoadMetricsRead, "paint"> & { paint: LoadPaintHint } {
  const perf = performance;
  const navigation = perf.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
  const fcp = perf.getEntriesByType("paint").find((e) => e.name === "first-contentful-paint");

  const out: PerformanceMetrics = {
    ttfb: navigation?.responseStart - navigation?.requestStart,
    domContentLoaded: navigation?.domContentLoadedEventEnd - navigation?.startTime,
    load: navigation?.loadEventEnd - navigation?.startTime,
    fcp: fcp?.startTime,
  };

  const w = window as unknown as PerfWindow;
  const store = w.__perf && w.__perf.__lb === true ? w.__perf : undefined;
  store?.flush?.();
  let hiddenEntry = false;
  for (const e of perf.getEntriesByType("visibility-state")) if (e.name === "hidden") hiddenEntry = true;
  // Image responses later than the LCP candidate, by the same pre-filter
  // lightbringer's paint wait applies before it looks at the DOM.
  let lateImages = 0;
  if (store) {
    const cand = store.vitals.LCP;
    const entry = cand?.attribution?.lcpEntry as { startTime: number; url?: string } | undefined;
    const candTime = entry ? entry.startTime : typeof cand?.value === "number" ? cand.value : Number.NEGATIVE_INFINITY;
    const candUrl = entry?.url ?? "";
    for (const r of perf.getEntriesByType("resource") as PerformanceResourceTiming[]) {
      if (r.responseEnd <= candTime || r.name === candUrl || !(r.encodedBodySize > 0)) continue;
      const type = (r as PerformanceResourceTiming & { contentType?: string }).contentType;
      if (type ? !type.startsWith("image/") : r.initiatorType === "script" || r.initiatorType === "fetch" || r.initiatorType === "xmlhttprequest")
        continue;
      lateImages++;
    }
  }
  const paint: LoadPaintHint = {
    timeOrigin: perf.timeOrigin,
    visible: document.visibilityState === "visible" && !(document as Document & { prerendering?: boolean }).prerendering,
    collector: store !== undefined,
    webVitals: w.webVitals !== undefined,
    hiddenEntry,
    fcpVital: store?.vitals.FCP !== undefined,
    lateImages,
    input: perf.getEntriesByType("first-input").length > 0,
  };
  if (!store) return { metrics: out, longTasks: null, paint };

  const lcp = store.vitals.LCP?.value;
  if (typeof lcp === "number") out.lcp = lcp;
  // Long-task starts and FCP are both native entry timestamps on this
  // document's timeline, so a clock-skew fault cannot shift one
  // against the other.
  const from = fcp?.startTime ?? 0;
  // A collector older than `longTaskLog` has only the drained `longTasks`.
  const tasks = store.longTaskLog ?? store.longTasks;
  let tbt = 0;
  for (const task of tasks) {
    if (task.start >= from) tbt += Math.max(0, task.duration - 50);
  }
  out.tbt = tbt;
  return { metrics: out, longTasks: tasks.map((t) => ({ start: t.start, duration: t.duration })), paint };
}

/** `collectLoadMetrics`, with the long tasks and the paint hint. Never throws. */
export async function readLoadMetrics(page: Page): Promise<LoadMetricsRead> {
  try {
    return await page.evaluate(chaosbringerLoadMetrics);
  } catch {
    return { metrics: {}, longTasks: null, paint: null };
  }
}

/**
 * Whether a paint drawn but not yet presented can still change this read, so
 * the crawler should check for one (`awaitPendingPaint`): FCP absent, the FCP
 * vital not yet delivered, or an image response later than the LCP candidate
 * before any input. A normal load answers no, so it pays no extra evaluate.
 * No on a hidden document (it reports no paint) and on a failed read (nothing
 * a later read found could be merged into it).
 */
export function paintCheckNeeded(read: LoadMetricsRead): boolean {
  const h = read.paint;
  if (!h || !h.visible) return false;
  if (read.metrics.fcp === undefined) return true;
  if (!h.collector || !h.webVitals || h.hiddenEntry) return false;
  return !h.fcpVital || (!h.input && h.lateImages > 0);
}

/** FCP / LCP read again after the wait, and the document they are from. */
export interface LatePaint {
  fcp: number | null;
  lcp: number | null;
  timeOrigin: number | null;
}

/**
 * Merge a read taken after the paint wait into the first read: FCP and LCP
 * from the late read where it has them (an entry only appears, or LCP moves to
 * a larger candidate, once presented; an absent late value never removes one),
 * and TBT recomputed from the first read's long tasks when FCP changed, as
 * `readLoadMetrics` would have with that FCP. Long tasks after the first read
 * are not the load's, and stay out. Only from the same document: a late read
 * of another document (the page navigated) keeps the first read.
 */
export function withLatePaint(first: LoadMetricsRead, late: LatePaint): PerformanceMetrics {
  if (late.timeOrigin === null || late.timeOrigin !== first.paint?.timeOrigin) return first.metrics;
  const out: PerformanceMetrics = { ...first.metrics };
  if (typeof late.fcp === "number") out.fcp = late.fcp;
  if (typeof late.lcp === "number") out.lcp = late.lcp;
  if (first.longTasks && typeof out.tbt === "number" && out.fcp !== first.metrics.fcp) {
    const from = out.fcp ?? 0;
    let tbt = 0;
    for (const task of first.longTasks) if (task.start >= from) tbt += Math.max(0, task.duration - 50);
    out.tbt = tbt;
  }
  return out;
}

/** What the late read changed, as [first read, final]. */
export type LatePaintChanges = Partial<Record<"fcp" | "lcp" | "tbt", [number | null, number | null]>>;

/** Which of FCP / LCP / TBT the merge changed; null when none did. */
export function latePaintChanges(before: PerformanceMetrics, after: PerformanceMetrics): LatePaintChanges | null {
  const out: LatePaintChanges = {};
  for (const k of ["fcp", "lcp", "tbt"] as const) {
    if (before[k] !== after[k]) out[k] = [before[k] ?? null, after[k] ?? null];
  }
  return Object.keys(out).length > 0 ? out : null;
}
