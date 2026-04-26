/**
 * chaosbringer
 *
 * Playwright-based chaos testing library for web applications.
 * Inspired by monkey testing with additional features for error detection and reporting.
 */
// Core
export { ChaosCrawler, COMMON_IGNORE_PATTERNS, validateOptions } from "./crawler.js";
export { formatReport, formatCompactReport, saveReport, printReport, getExitCode } from "./reporter.js";
export { Logger, createNullLogger } from "./logger.js";
export { chaos } from "./chaos.js";
export { faults } from "./faults.js";
export { clusterErrors, fingerprintError } from "./clusters.js";
export { diffReports, loadBaseline, hasRegressions } from "./diff.js";
export { checkPerformanceBudget } from "./budget.js";
export { invariants, axe, buildAxeRunPayload, formatAxeViolations } from "./invariants.js";
export { compareScreenshotBuffers, formatVisualDiff, screenshotFilename, visualRegression, } from "./visual.js";
export { TRACE_FORMAT_VERSION, actionToTraceEntry, groupTrace, metaOf, parseTrace, readTrace, serializeTrace, writeTrace, } from "./trace.js";
export { ddmin, minimizeTrace, reportMatches, traceWithActions, } from "./minimize.js";
export { flakeReport, formatFlakeReport, } from "./flake.js";
export { buildGithubAnnotations, formatGithubAnnotation, printGithubAnnotations, } from "./github.js";
export { fnv1a, mergeReports, parseShardArg, shardOwns } from "./shard.js";
export { buildActionHeatmap, formatHeatmap } from "./heatmap.js";
export { parseMetaRefreshUrl } from "./links.js";
// Playwright Test integration
export { chaosTest, withChaos, runChaosTest, chaosExpect } from "./fixture.js";
export { NETWORK_PROFILES, PERF_BUDGET_KEYS } from "./types.js";
export { networkConditionsFor } from "./network.js";
export { fetchSitemapUrls, isSitemapIndex, parseSitemap, } from "./sitemap.js";
