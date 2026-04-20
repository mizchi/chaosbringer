/**
 * Pure helpers for URL / error filtering and summary calculation.
 * Extracted from ChaosCrawler so they can be tested without Playwright.
 */

import type { CrawlSummary, PageResult, DiscoveryMetrics } from "./types.js";

/** True if any pattern (regex string) matches `value`. Invalid regex is skipped. */
export function matchesAnyPattern(
  value: string,
  patterns: readonly string[] | undefined,
  flags?: string
): boolean {
  if (!patterns || patterns.length === 0) return false;
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern, flags).test(value)) return true;
    } catch {
      // Invalid regex, skip
    }
  }
  return false;
}

/** Return the first SPA pattern that matches the URL, or null. */
export function matchesSpaPattern(
  url: string,
  patterns: readonly string[] | undefined
): string | null {
  if (!patterns) return null;
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern).test(url)) return pattern;
    } catch {
      // Invalid regex, skip
    }
  }
  return null;
}

/** True if `url` has a different origin from `baseOrigin`. Invalid URL → false. */
export function isExternalUrl(url: string, baseOrigin: string): boolean {
  try {
    return new URL(url).origin !== baseOrigin;
  } catch {
    return false;
  }
}

/** Escape text for use in a Playwright selector string. */
export function escapeSelector(text: string): string {
  return text.replace(/"/g, '\\"').replace(/\n/g, " ").slice(0, 50);
}

/** Compute summary statistics from a list of page results. */
export function summarizePages(
  results: readonly PageResult[],
  discovery?: DiscoveryMetrics
): CrawlSummary {
  const successPages = results.filter((r) => r.status === "success").length;
  const errorPages = results.filter((r) => r.status === "error").length;
  const timeoutPages = results.filter((r) => r.status === "timeout").length;
  const recoveredPages = results.filter((r) => r.status === "recovered").length;

  const allErrors = results.flatMap((r) => r.errors);
  const consoleErrors = allErrors.filter((e) => e.type === "console").length;
  const networkErrors = allErrors.filter((e) => e.type === "network").length;
  const jsExceptions = allErrors.filter((e) => e.type === "exception").length;
  const unhandledRejections = allErrors.filter((e) => e.type === "unhandled-rejection").length;

  const loadTimes = results.map((r) => r.loadTime);
  const avgLoadTime =
    loadTimes.length > 0 ? loadTimes.reduce((a, b) => a + b, 0) / loadTimes.length : 0;

  let avgMetrics: CrawlSummary["avgMetrics"] = undefined;
  const metricsResults = results.filter((r) => r.metrics);
  if (metricsResults.length > 0) {
    const ttfbs = metricsResults
      .map((r) => r.metrics!.ttfb)
      .filter((v): v is number => v !== undefined);
    const fcps = metricsResults
      .map((r) => r.metrics!.fcp)
      .filter((v): v is number => v !== undefined);
    const lcps = metricsResults
      .map((r) => r.metrics!.lcp)
      .filter((v): v is number => v !== undefined);

    if (ttfbs.length > 0 || fcps.length > 0 || lcps.length > 0) {
      avgMetrics = {
        ttfb: ttfbs.length > 0 ? ttfbs.reduce((a, b) => a + b, 0) / ttfbs.length : 0,
        fcp: fcps.length > 0 ? fcps.reduce((a, b) => a + b, 0) / fcps.length : 0,
        lcp: lcps.length > 0 ? lcps.reduce((a, b) => a + b, 0) / lcps.length : 0,
      };
    }
  }

  return {
    successPages,
    errorPages,
    timeoutPages,
    recoveredPages,
    consoleErrors,
    networkErrors,
    jsExceptions,
    unhandledRejections,
    avgLoadTime,
    avgMetrics,
    discovery,
  };
}
