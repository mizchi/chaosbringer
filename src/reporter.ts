/**
 * Report generation and formatting utilities
 */

import { writeFileSync } from "node:fs";
import type { CrawlReport, PageResult } from "./types.js";

export function formatReport(report: CrawlReport): string {
  const lines: string[] = [];

  lines.push("=".repeat(60));
  lines.push("CHAOS CRAWLER REPORT");
  lines.push("=".repeat(60));
  lines.push("");
  lines.push(`Base URL: ${report.baseUrl}`);
  lines.push(`Seed: ${report.seed}`);
  lines.push(`Repro: ${report.reproCommand}`);
  lines.push(`Duration: ${(report.duration / 1000).toFixed(2)}s`);
  lines.push(`Pages Visited: ${report.pagesVisited}`);
  if (report.blockedExternalNavigations > 0) {
    lines.push(`Blocked External Navigations: ${report.blockedExternalNavigations}`);
  }
  lines.push("");

  // Summary
  lines.push("-".repeat(40));
  lines.push("SUMMARY");
  lines.push("-".repeat(40));
  lines.push(`Success: ${report.summary.successPages}`);
  lines.push(`Errors: ${report.summary.errorPages}`);
  lines.push(`Timeouts: ${report.summary.timeoutPages}`);
  if (report.summary.recoveredPages > 0) {
    lines.push(`Recovered (404/5xx): ${report.summary.recoveredPages}`);
  }
  if (report.summary.pagesWithErrors > 0) {
    // A page can have status=success but still hold console/exception errors,
    // so surface that count separately from navigation outcomes.
    lines.push(`Pages with errors: ${report.summary.pagesWithErrors}`);
  }
  lines.push(`Console Errors: ${report.summary.consoleErrors}`);
  lines.push(`Network Errors: ${report.summary.networkErrors}`);
  lines.push(`JS Exceptions: ${report.summary.jsExceptions}`);
  lines.push(`Unhandled Rejections: ${report.summary.unhandledRejections}`);
  if (report.summary.invariantViolations > 0) {
    lines.push(`Invariant Violations: ${report.summary.invariantViolations}`);
  }
  lines.push(`Avg Load Time: ${report.summary.avgLoadTime.toFixed(0)}ms`);

  if (report.summary.avgMetrics) {
    const m = report.summary.avgMetrics;
    const entries: string[] = [];
    if (m.ttfb > 0) entries.push(`  TTFB: ${m.ttfb.toFixed(0)}ms`);
    if (m.fcp > 0) entries.push(`  FCP: ${m.fcp.toFixed(0)}ms`);
    if (m.lcp > 0) entries.push(`  LCP: ${m.lcp.toFixed(0)}ms`);
    if (entries.length > 0) {
      lines.push("");
      lines.push("Performance Metrics (avg):");
      lines.push(...entries);
    }
  }

  // Error details
  const pagesWithErrors = report.pages.filter((p) => p.errors.length > 0);
  if (pagesWithErrors.length > 0) {
    lines.push("");
    lines.push("-".repeat(40));
    lines.push("ERRORS BY PAGE");
    lines.push("-".repeat(40));

    for (const page of pagesWithErrors) {
      lines.push("");
      lines.push(`[${page.status.toUpperCase()}] ${page.url}`);
      for (const error of page.errors) {
        lines.push(`  [${error.type}] ${truncate(error.message, 80)}`);
      }
    }
  }

  // Timeout pages
  const timeoutPages = report.pages.filter((p) => p.status === "timeout");
  if (timeoutPages.length > 0) {
    lines.push("");
    lines.push("-".repeat(40));
    lines.push("TIMEOUT PAGES");
    lines.push("-".repeat(40));
    for (const page of timeoutPages) {
      lines.push(`  ${page.url}`);
    }
  }

  // Dead links with source information
  if (report.summary.discovery?.deadLinks && report.summary.discovery.deadLinks.length > 0) {
    lines.push("");
    lines.push("-".repeat(40));
    lines.push("DEAD LINKS (with source)");
    lines.push("-".repeat(40));
    for (const deadLink of report.summary.discovery.deadLinks) {
      lines.push("");
      lines.push(`  URL: ${deadLink.url}`);
      lines.push(`  Status: ${deadLink.statusCode}`);
      lines.push(`  Found on: ${deadLink.sourceUrl || "(initial)"}`);
      if (deadLink.sourceElement) {
        lines.push(`  Element: ${truncate(deadLink.sourceElement, 50)}`);
      }
      lines.push(`  Method: ${deadLink.method}`);
    }
  }

  // SPA issues (separate from regular errors)
  if (report.summary.discovery?.spaIssues && report.summary.discovery.spaIssues.length > 0) {
    lines.push("");
    lines.push("-".repeat(40));
    lines.push("SPA ISSUES (expected behavior)");
    lines.push("-".repeat(40));
    for (const issue of report.summary.discovery.spaIssues) {
      lines.push(`  ${issue.url}`);
      lines.push(`    Type: ${issue.type}`);
      lines.push(`    Pattern: ${issue.matchedPattern}`);
    }
  }

  // Discovery metrics
  if (report.summary.discovery) {
    lines.push("");
    lines.push("-".repeat(40));
    lines.push("DISCOVERY METRICS");
    lines.push("-".repeat(40));
    lines.push(`  Extracted links: ${report.summary.discovery.extractedLinks}`);
    lines.push(`  Clicked links: ${report.summary.discovery.clickedLinks}`);
    lines.push(`  Unique pages: ${report.summary.discovery.uniquePages}`);
    lines.push(`  Dead links: ${report.summary.discovery.deadLinks.length}`);
    if (report.summary.discovery.spaIssues.length > 0) {
      lines.push(`  SPA issues: ${report.summary.discovery.spaIssues.length}`);
    }
  }

  // Recovered pages with recent actions
  const recoveredPages = report.pages.filter((p) => p.status === "recovered" && p.recovery);
  if (recoveredPages.length > 0) {
    lines.push("");
    lines.push("-".repeat(40));
    lines.push("RECOVERED PAGES (404/5xx)");
    lines.push("-".repeat(40));
    for (const page of recoveredPages) {
      lines.push("");
      lines.push(`  Failed URL: ${page.recovery!.failedUrl}`);
      lines.push(`  Error: ${page.recovery!.error}`);
      lines.push(`  Recovered to: ${page.recovery!.recoveredTo}`);
      if (page.recovery!.recentActions.length > 0) {
        lines.push(`  Recent actions before failure:`);
        for (const action of page.recovery!.recentActions.slice(-5)) {
          const target = action.target ? ` "${truncate(action.target, 30)}"` : "";
          lines.push(`    - ${action.type}${target}`);
        }
      }
    }
  }

  if (report.errorClusters.length > 0) {
    lines.push("");
    lines.push("-".repeat(40));
    lines.push("ERROR CLUSTERS");
    lines.push("-".repeat(40));
    for (const cluster of report.errorClusters) {
      const countStr = cluster.count > 1 ? `×${cluster.count}` : "";
      const urlStr = cluster.urls.length > 1 ? ` [${cluster.urls.length} urls]` : "";
      lines.push(`  [${cluster.type}]${countStr}${urlStr} ${truncate(cluster.fingerprint, 80)}`);
    }
  }

  if (report.faultInjections && report.faultInjections.length > 0) {
    lines.push("");
    lines.push("-".repeat(40));
    lines.push("FAULT INJECTION");
    lines.push("-".repeat(40));
    for (const stats of report.faultInjections) {
      lines.push(`  ${stats.rule}: matched=${stats.matched} injected=${stats.injected}`);
    }
  }

  lines.push("");
  lines.push("=".repeat(60));

  return lines.join("\n");
}

export function formatCompactReport(report: CrawlReport, strict = false): string {
  // Use the same rule as getExitCode so the human label matches the exit
  // code. Previously the label ignored strict mode and console errors,
  // producing `[PASS]` runs that exited 1. See #6.
  const status = getExitCode(report, strict) === 0 ? "PASS" : "FAIL";
  const errors = report.summary.consoleErrors + report.summary.networkErrors + report.summary.jsExceptions;

  return [
    `[${status}] ${report.pagesVisited} pages, ${errors} errors, ${(report.duration / 1000).toFixed(1)}s (seed=${report.seed})`,
    report.summary.avgMetrics
      ? `  Metrics: TTFB=${report.summary.avgMetrics.ttfb.toFixed(0)}ms, FCP=${report.summary.avgMetrics.fcp.toFixed(0)}ms`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function saveReport(report: CrawlReport, path: string): void {
  writeFileSync(path, JSON.stringify(report, null, 2));
}

export function printReport(report: CrawlReport, compact = false, strict = false): void {
  console.log(compact ? formatCompactReport(report, strict) : formatReport(report));
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

// CI-friendly exit code helper
export function getExitCode(report: CrawlReport, strict = false): number {
  if (report.summary.errorPages > 0 || report.summary.timeoutPages > 0) {
    return 1;
  }
  // Invariant violations always fail — the whole point of declaring them.
  if (report.summary.invariantViolations > 0) {
    return 1;
  }
  if (strict && (report.summary.consoleErrors > 0 || report.summary.jsExceptions > 0)) {
    return 1;
  }
  return 0;
}
