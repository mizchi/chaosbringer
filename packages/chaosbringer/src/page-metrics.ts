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
 * The collector is read without draining it: entries stay in the store for
 * a perf session that drains them later. `flush()` first moves observer
 * records the browser has queued but not yet delivered, so a long task at
 * the very end of the load is not missed.
 *
 * A page without the collector — a caller-owned page on the `testPage()`
 * path, or `setContent` — keeps today's four fields and leaves `lcp` and
 * `tbt` absent. Absent, never 0: a 0 would pass every budget and read as
 * "measured, and fast".
 */
export async function collectLoadMetrics(page: Page): Promise<PerformanceMetrics> {
  try {
    const metrics = await page.evaluate(() => {
      const perf = performance;
      const navigation = perf.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
      const paint = perf.getEntriesByType("paint");

      const fcp = paint.find((e) => e.name === "first-contentful-paint");

      const out: PerformanceMetrics = {
        ttfb: navigation?.responseStart - navigation?.requestStart,
        domContentLoaded: navigation?.domContentLoadedEventEnd - navigation?.startTime,
        load: navigation?.loadEventEnd - navigation?.startTime,
        fcp: fcp?.startTime,
      };

      const store = (window as unknown as PerfWindow).__perf;
      if (!store || store.__lb !== true) return out;
      store.flush?.();
      const lcp = store.vitals.LCP?.value;
      if (typeof lcp === "number") out.lcp = lcp;
      // Long-task starts and FCP are both native entry timestamps on this
      // document's timeline, so a clock-skew fault cannot shift one
      // against the other.
      const from = fcp?.startTime ?? 0;
      let tbt = 0;
      for (const task of store.longTasks) {
        if (task.start >= from) tbt += Math.max(0, task.duration - 50);
      }
      out.tbt = tbt;
      return out;
    });

    return metrics;
  } catch {
    return {};
  }
}
