/**
 * Pure helpers for URL / error filtering and summary calculation.
 * Extracted from ChaosCrawler so they can be tested without Playwright.
 */
import type { CrawlSummary, PageResult, DiscoveryMetrics } from "./types.js";
/** True if any pattern (regex string) matches `value`. Invalid regex is skipped. */
export declare function matchesAnyPattern(value: string, patterns: readonly string[] | undefined, flags?: string): boolean;
/** Return the first SPA pattern that matches the URL, or null. */
export declare function matchesSpaPattern(url: string, patterns: readonly string[] | undefined): string | null;
/** True if `url` has a different origin from `baseOrigin`. Invalid URL → false. */
export declare function isExternalUrl(url: string, baseOrigin: string): boolean;
/** Escape text for use in a Playwright selector string. */
export declare function escapeSelector(text: string): string;
/**
 * Canonical form used for queue dedupe. Drops the fragment, lowercases the
 * host, and treats `http://x` and `http://x/` as the same URL. Trailing
 * slashes on non-root paths are stripped so `/about` and `/about/` don't
 * visit twice. Invalid input round-trips unchanged.
 */
export declare function normalizeUrl(raw: string): string;
/** Compute summary statistics from a list of page results. */
export declare function summarizePages(results: readonly PageResult[], discovery?: DiscoveryMetrics): CrawlSummary;
//# sourceMappingURL=filters.d.ts.map