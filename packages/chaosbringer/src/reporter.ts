/**
 * Report generation and formatting utilities
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fingerprintError, type ErrorCluster } from "./clusters.js";
import { perfKeyRoute } from "./perf-key.js";
import { slowestActions } from "./perf-summary.js";
import { describeOffsiteNavigation, offsiteRedirects } from "./offsite-navigation.js";
import { isFaultEcho } from "./resource-outcomes.js";
import { type RunWarning, warningTimes } from "./run-warnings.js";
import type { CrawlReport, PageError, PageResult, PerfDegradationEntry } from "./types.js";

/** Failed files listed under an error cluster; the JSON has them all. */
const CLUSTER_RESOURCES_SHOWN = 5;
/** Error clusters the compact report lists under a failing verdict. */
const COMPACT_CLUSTERS_SHOWN = 3;
/** Off-site navigations the text report lists; the JSON has them all. */
const OFFSITE_NAVIGATIONS_SHOWN = 20;

export function formatReport(report: CrawlReport): string {
  const lines: string[] = [];

  lines.push("=".repeat(60));
  lines.push("CHAOS CRAWLER REPORT");
  lines.push("=".repeat(60));
  lines.push("");
  lines.push(`Base URL: ${report.baseUrl}`);
  lines.push(`Seed: ${report.seed}`);
  lines.push(`Repro: ${report.reproCommand}`);
  if (report.har) {
    const arrow = report.har.mode === "record" ? "→" : "←";
    lines.push(`HAR:   ${report.har.mode} ${arrow} ${report.har.path}`);
  }
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
  if ((report.summary.crashes ?? 0) > 0) {
    lines.push(`Renderer Crashes: ${report.summary.crashes}`);
  }
  lines.push(`Unhandled Rejections: ${report.summary.unhandledRejections}`);
  if (report.summary.invariantViolations > 0) {
    lines.push(`Invariant Violations: ${report.summary.invariantViolations}`);
  }
  const http = report.summary.httpErrors;
  if (http && http.total > 0) {
    // Among the console errors above, not on top of them.
    const statuses = Object.entries(http.byStatus)
      .map(([status, n]) => `${status}×${n}`)
      .join(", ");
    lines.push(`HTTP Errors (of the console errors): ${http.total} (4xx: ${http["4xx"]}, 5xx: ${http["5xx"]}; ${statuses})`);
  }
  if ((report.summary.faultEchoes ?? 0) > 0) {
    lines.push(`Fault echoes (not counted above): ${report.summary.faultEchoes}`);
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

  lines.push(...formatPerfSection(report));

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
        const echo = error.causedByFault !== undefined ? ` (echo of fault ${error.causedByFault})` : "";
        lines.push(`  [${error.type}] ${truncate(error.message, 80)}${echo}`);
        // "Failed to load resource" alone does not say which file.
        if (error.resourceUrl) {
          const request = error.status !== undefined ? ` (${error.method ?? "?"} ${error.status})` : "";
          lines.push(`    resource: ${error.resourceUrl}${request}`);
        }
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

  lines.push(...formatOffsiteNavigations(report));

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
      lines.push(`  ${formatClusterLine(cluster)}`);
      const resources = cluster.resourceUrls ?? [];
      for (const url of resources.slice(0, CLUSTER_RESOURCES_SHOWN)) lines.push(`    resource: ${url}`);
      if (resources.length > CLUSTER_RESOURCES_SHOWN) {
        lines.push(`    … and ${resources.length - CLUSTER_RESOURCES_SHOWN} more`);
      }
    }
  }

  if (report.faultInjections && report.faultInjections.length > 0) {
    lines.push("");
    lines.push("-".repeat(40));
    lines.push("FAULT INJECTION");
    lines.push("-".repeat(40));
    for (const stats of report.faultInjections) {
      // `suppressed` only when it happened: on most runs every row would read
      // `suppressed=0` and a reader would stop seeing the column.
      const suppressed = stats.suppressed ? ` suppressed=${stats.suppressed}` : "";
      const echoes = stats.echoes ? ` echoes=${stats.echoes}` : "";
      lines.push(
        `  ${stats.rule}: matched=${stats.matched} injected=${stats.injected}${suppressed}${echoes}`,
      );
    }
    if (report.heldRequests) {
      // Was JSON-only. A parked request is the whole point of an unbounded
      // `hang`, and it is also the explanation for the navigation timeout
      // sitting in the errors above — a reader who cannot see this number has
      // to guess.
      lines.push(
        `  requests held open (unbounded hang, aborted at teardown): ${report.heldRequests}`,
      );
    }
  }

  if (report.replayFidelity && report.replayFidelity.totalActions > 0) {
    const r = report.replayFidelity;
    const drift = r.totalActions - r.succeeded;
    const pct = ((r.succeeded / r.totalActions) * 100).toFixed(1);
    lines.push("");
    lines.push("-".repeat(40));
    lines.push("REPLAY FIDELITY");
    lines.push("-".repeat(40));
    lines.push(`  ${r.succeeded}/${r.totalActions} actions replayed cleanly (${pct}%)`);
    if (drift > 0) {
      lines.push(
        `  drift breakdown: selectorMissing=${r.selectorMissing} noSelectorRecorded=${r.noSelectorRecorded} threw=${r.threw}`
      );
    }
  }

  if (report.advisor && report.advisor.callsAttempted > 0) {
    const a = report.advisor;
    lines.push("");
    lines.push("-".repeat(40));
    lines.push("VLM ADVISOR");
    lines.push("-".repeat(40));
    lines.push(`  provider: ${a.provider}`);
    lines.push(
      `  calls: ${a.callsSucceeded}/${a.callsAttempted} succeeded (${a.picks.length} picks recorded)`
    );
    if (a.picks.length > 0) {
      const reasonCounts = new Map<string, number>();
      for (const p of a.picks) {
        reasonCounts.set(p.reason, (reasonCounts.get(p.reason) ?? 0) + 1);
      }
      const reasonStr = [...reasonCounts.entries()]
        .map(([r, n]) => `${r}=${n}`)
        .join(" ");
      lines.push(`  picks by reason: ${reasonStr}`);
    }
  }

  if (report.diff) {
    const d = report.diff;
    lines.push("");
    lines.push("-".repeat(40));
    lines.push(`DIFF vs BASELINE${d.baselinePath ? ` (${d.baselinePath})` : ""}`);
    lines.push("-".repeat(40));
    lines.push(
      `  New clusters: ${d.newClusters.length}   Resolved: ${d.resolvedClusters.length}   Unchanged: ${d.unchangedClusters.length}`
    );
    lines.push(
      `  New failing pages: ${d.newFailedPages.length}   Resolved: ${d.resolvedFailedPages.length}`
    );
    if (d.newClusters.length > 0) {
      lines.push("  NEW clusters:");
      for (const c of d.newClusters) {
        lines.push(`    + [${c.type}]×${c.after} ${truncate(c.fingerprint, 72)}`);
      }
    }
    if (d.newFailedPages.length > 0) {
      lines.push("  NEW failing pages:");
      for (const p of d.newFailedPages) {
        const before = p.before ? `${p.before.status}/${p.before.errors}err` : "(new URL)";
        const after = p.after ? `${p.after.status}/${p.after.errors}err` : "(missing)";
        lines.push(`    + ${p.url}   ${before} → ${after}`);
      }
    }
    if (d.resolvedClusters.length > 0) {
      lines.push("  RESOLVED clusters:");
      for (const c of d.resolvedClusters) {
        lines.push(`    - [${c.type}]×${c.before} ${truncate(c.fingerprint, 72)}`);
      }
    }
    if (d.resolvedFailedPages.length > 0) {
      lines.push("  RESOLVED pages:");
      for (const p of d.resolvedFailedPages) {
        lines.push(`    - ${p.url}`);
      }
    }
  }

  // Last, so it is what a terminal shows of a long report: each one means
  // the run tested less than it was set up to.
  const warnings = report.warnings ?? [];
  if (warnings.length > 0) {
    lines.push("");
    lines.push("-".repeat(40));
    lines.push("WARNINGS (the run tested less than it was set up to)");
    lines.push("-".repeat(40));
    for (const w of warnings) lines.push(`  [${w.code}] ${w.message}${warningTimes(w)}`);
  }

  lines.push("");
  lines.push("=".repeat(60));

  return lines.join("\n");
}

export function formatCompactReport(report: CrawlReport, strict: boolean | ExitCodeOptions = false): string {
  const reasons = exitReasons(report, strict);
  const lines = [
    formatVerdictLine(report, strict),
    report.summary.avgMetrics
      ? `  Metrics: TTFB=${report.summary.avgMetrics.ttfb.toFixed(0)}ms, FCP=${report.summary.avgMetrics.fcp.toFixed(0)}ms`
      : "",
    deadLinksLine(report),
    offsiteRedirectsLine(report),
    warningsLine(report),
  ].filter(Boolean);
  if (reasons.length > 0) {
    // Compact mode prints nothing else about the run, so a bare [FAIL] left
    // the reader to open the JSON to learn which rule failed and on what.
    lines.push(failedLine(reasons));
    const fresh = new Set(report.diff?.newClusters.map((c) => c.key));
    const top = rankByVerdict(report, strict, fresh).slice(0, COMPACT_CLUSTERS_SHOWN);
    if (top.length > 0) {
      lines.push("  Top clusters:");
      for (const cluster of top) {
        lines.push(`    ${formatClusterLine(cluster)}${fresh.has(cluster.key) ? " (new)" : ""}`);
      }
      const more = report.errorClusters.length - top.length;
      if (more > 0) lines.push(`    … and ${more} more`);
    }
    if (report.reproCommand) lines.push(`  Repro: ${report.reproCommand}`);
  }
  return lines.join("\n");
}

/**
 * What `--quiet` prints of the report: the verdict line and, on FAIL, the
 * compact report's `Failed:` line. Without it a failing `--quiet` run said
 * FAIL and nothing of why.
 */
export function formatQuietReport(report: CrawlReport, strict: boolean | ExitCodeOptions = false): string {
  const reasons = exitReasons(report, strict);
  return [
    formatVerdictLine(report, strict),
    deadLinksLine(report),
    offsiteRedirectsLine(report),
    warningsLine(report),
    ...(reasons.length > 0 ? [failedLine(reasons)] : []),
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * `  Dead links: N (first: <url> <- <source>)`, or "" with none. In the
 * compact and quiet output whether or not `--fail-on-dead-links` fails the
 * run on them: that output said `1 errors` at most, and named no link.
 */
function deadLinksLine(report: Pick<CrawlReport, "summary">): string {
  const dead = report.summary.discovery?.deadLinks ?? [];
  return dead.length > 0 ? `  Dead links: ${dead.length}${firstDeadLink(dead)}` : "";
}

/**
 * `  Off-site redirects: N (first: <page> -> <target>)`, or "" with none: the
 * pages that sent the browser to another origin on their own (a script, a
 * meta refresh, a 3xx; `isOffsiteRedirect`), whether or not
 * `invariants.noOffsiteRedirect()` fails the run on them, as for dead links.
 * A click and an iframe are not counted.
 */
function offsiteRedirectsLine(report: Pick<CrawlReport, "pages">): string {
  const redirects = offsiteRedirects(report.pages ?? []);
  const first = redirects[0];
  return first ? `  Off-site redirects: ${redirects.length} (first: ${first.from} -> ${first.to})` : "";
}

/**
 * The text report's list of off-site navigations: each page's, as
 * `<page> -> <target> (<trigger>; …)`, where `Blocked External
 * Navigations` above only counts them. A report an older version wrote
 * has no `offsiteNavigations`; its `blockedNavigations` are listed without
 * a trigger.
 */
function formatOffsiteNavigations(report: CrawlReport): string[] {
  const rows = report.pages.flatMap((p) =>
    p.offsiteNavigations
      ? p.offsiteNavigations.map(describeOffsiteNavigation)
      : (p.blockedNavigations ?? []).map((to) => `${p.url} -> ${to}`),
  );
  if (rows.length === 0) return [];
  const out = ["", "-".repeat(40), "OFF-SITE NAVIGATIONS", "-".repeat(40)];
  for (const row of rows.slice(0, OFFSITE_NAVIGATIONS_SHOWN)) out.push(`  ${row}`);
  if (rows.length > OFFSITE_NAVIGATIONS_SHOWN) out.push(`  … and ${rows.length - OFFSITE_NAVIGATIONS_SHOWN} more`);
  return out;
}

/**
 * `  Warnings: N (first: <message>)`, or "" with none: on stdout with the
 * rest of the verdict block, like the dead-link line, whether or not
 * `--fail-on-warnings` fails the run on them.
 */
function warningsLine(report: Pick<CrawlReport, "warnings">): string {
  const warnings = report.warnings ?? [];
  return warnings.length > 0 ? `  Warnings: ${warnings.length}${firstWarning(warnings)}` : "";
}

/** ` (first: <message>)`. */
function firstWarning(warnings: readonly RunWarning[]): string {
  const first = warnings[0];
  return first ? ` (first: ${first.message})` : "";
}

/** ` (first: <url> <- <source>)`. */
function firstDeadLink(dead: NonNullable<CrawlReport["summary"]["discovery"]>["deadLinks"]): string {
  const first = dead[0];
  return first ? ` (first: ${first.url} <- ${first.sourceUrl || "(initial)"})` : "";
}

/** `  Failed: <reason>; <reason>`, from `exitReasons`. */
function failedLine(reasons: readonly string[]): string {
  return `  Failed: ${reasons.join("; ")}`;
}

/** Cluster types `--strict` fails a run on (`exitReasons`); network errors are not among them. */
const STRICT_CLUSTER_TYPES: ReadonlySet<ErrorCluster["type"]> = new Set(["console", "exception", "unhandled-rejection"]);

/**
 * Cluster types that fail a run in every mode: a violated invariant, a
 * page the crawler could not navigate (it failed to load or timed out),
 * a renderer crash.
 */
const ALWAYS_FAILING_CLUSTER_TYPES: ReadonlySet<ErrorCluster["type"]> = new Set(["invariant-violation", "navigation", "crash"]);

/**
 * `report.errorClusters` with the ones a rule that failed the run counts
 * first: new vs the baseline under `--baseline-strict` (`fresh`), then
 * invariant violations and the types `--strict` fails on, then the rest,
 * each group largest first. The three largest alone could all be clusters
 * the baseline already had, or network errors `--strict` ignores, and
 * leave the one that failed the run under "… and N more".
 */
function rankByVerdict(report: CrawlReport, strict: boolean | ExitCodeOptions, fresh: ReadonlySet<string>): ErrorCluster[] {
  const opts: ExitCodeOptions = typeof strict === "boolean" ? { strict } : strict;
  const failing = clusterFailsRun(report, opts);
  const rank = (c: ErrorCluster): number => {
    if (opts.baselineStrict && fresh.has(c.key)) return 2;
    if (failing(c)) return 1;
    return 0;
  };
  // A stable sort, so the count order errorClusters comes in holds within a rank.
  return [...report.errorClusters].sort((a, b) => rank(b) - rank(a));
}

/**
 * Whether a rule of `opts` counts `cluster`'s errors: an always-failing
 * type, a `--strict` type under `--strict`, a network error under
 * `--fail-on-network`, under `--fail-on-http` a console cluster with a
 * response at or over its status (read off the pages, as one cluster can
 * hold a page's own document and an API answering the same status), and
 * under `--baseline-strict` a cluster `report.diff` says is new. What the
 * compact report lists first and what the GitHub annotations mark as
 * `error`.
 */
export function clusterFailsRun(
  report: Partial<Pick<CrawlReport, "pages" | "diff">>,
  opts: ExitCodeOptions,
): (cluster: Pick<ErrorCluster, "key" | "type">) => boolean {
  const fresh = new Set(opts.baselineStrict ? report.diff?.newClusters.map((c) => c.key) : []);
  const httpKeys = new Set<string>();
  const floor = opts.http ? HTTP_FLOORS[opts.http] : undefined;
  if (floor !== undefined) {
    for (const e of report.pages?.flatMap((p) => p.errors) ?? []) {
      if (e.type === "console" && !isFaultEcho(e) && (e.status ?? 0) >= floor) httpKeys.add(`console|${fingerprintError(e)}`);
    }
  }
  return (c) =>
    ALWAYS_FAILING_CLUSTER_TYPES.has(c.type) ||
    (!!opts.strict && STRICT_CLUSTER_TYPES.has(c.type)) ||
    (!!opts.network && c.type === "network") ||
    httpKeys.has(c.key) ||
    fresh.has(c.key);
}

/**
 * `[PASS|FAIL] <pages> pages, <errors> errors, <seconds>s (seed=<seed>)`:
 * the first line of the compact report and of what `--quiet` prints.
 */
export function formatVerdictLine(report: CrawlReport, strict: boolean | ExitCodeOptions = false): string {
  // Use the same rule as getExitCode so the human label matches the exit
  // code. Previously the label ignored strict mode and console errors,
  // producing `[PASS]` runs that exited 1. See #6.
  const status = getExitCode(report, strict) === 0 ? "PASS" : "FAIL";
  // Every kind the run recorded. Rejections and invariant violations were
  // left out, so a `--strict` run that failed on a rejection alone printed
  // `[FAIL] 1 pages, 0 errors`.
  const s = report.summary;
  // A failed navigation has no summary count of its own (it is not a JS
  // exception, which is where it used to be counted): read it off the pages.
  const navigations = report.pages.reduce((n, p) => n + p.errors.filter((e) => e.type === "navigation").length, 0);
  const errors =
    s.consoleErrors +
    s.networkErrors +
    s.jsExceptions +
    navigations +
    (s.crashes ?? 0) +
    s.unhandledRejections +
    s.invariantViolations;
  const diffSuffix = report.diff
    ? ` diff=+${report.diff.newClusters.length}c/+${report.diff.newFailedPages.length}p`
    : "";
  const advisorSuffix =
    report.advisor && report.advisor.callsAttempted > 0
      ? ` advisor=${report.advisor.callsSucceeded}/${report.advisor.callsAttempted}`
      : "";
  return `[${status}] ${report.pagesVisited} pages, ${errors} errors, ${(report.duration / 1000).toFixed(1)}s (seed=${report.seed})${diffSuffix}${advisorSuffix}`;
}

/** `[type]×count [N urls] fingerprint`, as the full and the compact report list a cluster. */
function formatClusterLine(cluster: ErrorCluster): string {
  const countStr = cluster.count > 1 ? `×${cluster.count}` : "";
  const urlStr = cluster.urls.length > 1 ? ` [${cluster.urls.length} urls]` : "";
  return `[${cluster.type}]${countStr}${urlStr} ${truncate(cluster.fingerprint, 80)}`;
}

export function saveReport(report: CrawlReport, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2));
}

export function printReport(report: CrawlReport, compact = false, strict: boolean | ExitCodeOptions = false): void {
  console.log(compact ? formatCompactReport(report, strict) : formatReport(report));
}

/**
 * The per-step performance block: a line per measured page, then the
 * slowest actions. Empty — not even a header — when nothing was measured,
 * so a crawl without `perf` prints exactly what it always printed.
 */
function formatPerfSection(report: CrawlReport): string[] {
  const measured = report.pages.filter((p) => p.perf);
  if (measured.length === 0) return [];
  const ms = (n: number) => `${Math.round(n)}ms`;
  const out: string[] = ["", "-".repeat(40), "PER-STEP PERFORMANCE", "-".repeat(40)];
  for (const page of measured) {
    const load = page.perf!;
    const parts = [
      `load ${ms(load.durationMs)}`,
      `blocking ${ms(load.cpu.blockingMs)}`,
      `${load.network.requestCount} req / ${load.network.encodedKB}KB`,
    ];
    // Only what was measured: a page without an LCP candidate or without an
    // interaction shows no column rather than a 0 that reads as "fast".
    const lcp = page.perfPage?.vitals.LCP?.value ?? page.metrics?.lcp;
    if (lcp !== undefined) parts.push(`LCP ${ms(lcp)}`);
    const inp = page.perfPage?.vitals.INP?.value;
    if (inp !== undefined) parts.push(`INP ${ms(inp)}`);
    out.push(`  ${perfKeyRoute(load.key)}  ${parts.join("  ")}`);
  }
  const slow = slowestActions(report.actions);
  if (slow.length > 0) {
    out.push("");
    out.push("Slowest actions:");
    for (const row of slow) {
      const inp = row.interactionMs !== undefined ? `  interaction ${ms(row.interactionMs)}` : "";
      out.push(
        `  ${ms(row.durationMs).padStart(7)}  blocking ${ms(row.blockingMs)}${inp}  ${truncate(row.key, 80)}`,
      );
    }
  }
  out.push(...formatCrawlPerfSummary(report));
  return out;
}

/**
 * The crawl-wide lines from `report.perf`: vitals across pages, then the
 * top three initiators and third-party domains. Compact on purpose — the
 * full lists are in the JSON — and nothing at all without a summary.
 */
function formatCrawlPerfSummary(report: CrawlReport): string[] {
  const perf = report.perf;
  if (!perf) return [];
  const out: string[] = ["", `Across the crawl (${perf.totals.pages} pages, ${perf.totals.spans} spans):`];
  for (const [name, v] of Object.entries(perf.vitals)) {
    const unit = name === "CLS" ? "" : "ms";
    out.push(
      `  ${name.padEnd(4)} p50 ${v.p50}${unit}  p75 ${v.p75}${unit}  worst ${v.worst.value}${unit} ${truncate(v.worst.url, 60)}`,
    );
  }
  if (perf.hotInitiators.length > 0) {
    out.push(
      `  top initiators: ${perf.hotInitiators
        .slice(0, 3)
        .map((i) => `${truncate(i.frame, 50)} (${i.requestCount} req, ${i.encodedKB}KB)`)
        .join(", ")}`,
    );
  }
  if (perf.thirdParty.length > 0) {
    out.push(
      `  third party: ${perf.thirdParty
        .slice(0, 3)
        .map((d) => `${d.domain} (${d.requestCount} req, ${d.encodedKB}KB)`)
        .join(", ")}`,
    );
  }
  if (perf.coverage) {
    for (const kind of ["js", "css"] as const) {
      const c = perf.coverage[kind];
      if (c.totalBytes === 0) continue;
      const worst = c.lowUsage[0];
      out.push(
        `  ${kind.toUpperCase()} coverage (union over the crawl): ${c.usedPct}% used` +
          (worst ? `, least used ${truncate(worst.url, 60)} (${worst.usedPct}%)` : ""),
      );
    }
  }
  out.push(...formatDegradation(perf.degradation ?? []));
  if (perf.trends && perf.trends.length > 0) {
    out.push("", "Memory climbing across repeats of a step (likely leak):");
    for (const t of perf.trends.slice(0, 5)) {
      out.push(
        `  ${t.metric} +${t.growth} over ${t.count} repeats (${t.values[0]} -> ${t.values[t.values.length - 1]})  ${truncate(t.name, 70)}`,
      );
    }
  }
  return out;
}

/**
 * The top five `(perfKey, fault)` pairs of `perf.degradation`, one line
 * each: the median step with the fault against without it, by `effectiveMs`
 * (falling back to `durationMs` for a report written before that field). The JSON keeps
 * all ten and the blocking / request / interaction sides.
 */
function formatDegradation(rows: readonly PerfDegradationEntry[]): string[] {
  if (rows.length === 0) return [];
  // Round before choosing the sign: -0.4 must print "+0", not a bare "0"
  // (Math.round(-0.4) is -0, which prints as "0" but is not >= 0's branch).
  const signed = (n: number, unit = "") => {
    const r = Math.round(n) || 0;
    return `${r >= 0 ? "+" : ""}${r}${unit}`;
  };
  const out = ["", "Degradation under faults (median with vs without):"];
  for (const r of rows.slice(0, 5)) {
    // The lead number is the effective delta (wall time stretched to when the
    // step's own requests finished); the span's own wall-time delta is added
    // when it differs, e.g. a click whose fetch networkidle did not wait for.
    const effective = r.delta.effectiveMs ?? r.delta.durationMs;
    const extra = [
      Math.round(effective) !== Math.round(r.delta.durationMs) ? `span ${signed(r.delta.durationMs, "ms")}` : "",
      r.delta.blockingMs !== 0 ? `blocking ${signed(r.delta.blockingMs, "ms")}` : "",
      r.delta.requestCount !== 0 ? `${signed(r.delta.requestCount)} req` : "",
      r.delta.interactionMs !== undefined ? `interaction ${signed(r.delta.interactionMs, "ms")}` : "",
    ].filter(Boolean);
    out.push(
      `  ${signed(effective, "ms").padStart(8)}  ${truncate(r.key, 60)}  under ${truncate(r.fault, 40)}` +
        `  (${Math.round(r.faulted.effectiveMs ?? r.faulted.durationMs)}ms n=${r.faulted.n} vs ${Math.round(r.clean.effectiveMs ?? r.clean.durationMs)}ms n=${r.clean.n})` +
        (extra.length > 0 ? `  ${extra.join("  ")}` : ""),
    );
  }
  return out;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

/** `--fail-on-http`'s values: the lowest status that fails the run. */
export type HttpFailLevel = "4xx" | "5xx";
export const HTTP_FAIL_LEVELS: readonly HttpFailLevel[] = ["4xx", "5xx"];
const HTTP_FLOORS: Record<HttpFailLevel, number> = { "4xx": 400, "5xx": 500 };

export interface ExitCodeOptions {
  /** Treat console errors / JS exceptions as failures. */
  strict?: boolean;
  /** Fail when `report.diff` shows new clusters or newly failing pages. */
  baselineStrict?: boolean;
  /**
   * `--fail-on-http`: fail on a subresource or API response of status 500
   * and up (`"5xx"`) or 400 and up (`"4xx"`), `summary.httpErrors`. Not the
   * page's own document, which is a dead link (`deadLinks`), nor the echo
   * of a fault the run injected.
   */
  http?: HttpFailLevel;
  /**
   * `--fail-on-network`: fail on a request that failed at the transport
   * level (`summary.networkErrors`), which no other rule does, `--strict`
   * included.
   */
  network?: boolean;
  /** `--fail-on-dead-links`: fail on a crawled link that answered 404 / 5xx (`summary.discovery.deadLinks`). */
  deadLinks?: boolean;
  /**
   * `--fail-on-warnings`: fail on a run that has warnings (`report.warnings`),
   * the setup problems that made it test less than asked: a fault that never
   * fired, a sitemap that could not be read, a driver that threw.
   */
  warnings?: boolean;
}

/** What `getExitCode` / `exitReasons` read from a report. */
type ExitCodeReport = Pick<CrawlReport, "summary" | "diff"> & Partial<Pick<CrawlReport, "pages" | "warnings">>;

// CI-friendly exit code helper. The second argument is accepted as either a
// boolean (legacy `strict`) or an options object so callers can opt into
// baseline-strict without a larger API change. The verdict reads only
// `summary`, `diff` and (under `warnings`) `warnings`, so a caller judging
// something smaller than a crawl — the Playwright fixture's single
// `testPage()` — applies this rule rather than a copy of it; `pages`, when
// given, only names the first failing URL.
export function getExitCode(report: ExitCodeReport, strict: boolean | ExitCodeOptions = false): number {
  return exitReasons(report, strict).length > 0 ? 1 : 0;
}

/**
 * Why `getExitCode` fails the report, one entry per rule that failed it
 * (e.g. `--strict: 1 unhandled rejection`); empty when it passes. The exit
 * code is computed from this list, so what the compact report says failed
 * is what failed.
 */
export function exitReasons(report: ExitCodeReport, strict: boolean | ExitCodeOptions = false): string[] {
  const opts: ExitCodeOptions = typeof strict === "boolean" ? { strict } : strict;
  const s = report.summary;
  const out: string[] = [];
  // A crashed page has status "error" too, and is named as a crash: it loaded.
  const crashes = s.crashes ?? 0;
  const loadFailures = Math.max(0, s.errorPages - crashes);
  if (loadFailures > 0) {
    out.push(`${plural(loadFailures, "page")} failed to load${firstUrl(report, (p) => p.status === "error" && !crashed(p))}`);
  }
  if (s.timeoutPages > 0) out.push(`${plural(s.timeoutPages, "page")} timed out${firstUrl(report, (p) => p.status === "timeout")}`);
  // Always a failure: the page's process died, whatever the app did.
  if (crashes > 0) out.push(`${crashes} renderer ${crashes === 1 ? "crash" : "crashes"}${firstUrl(report, crashed)}`);
  // Invariant violations always fail — the whole point of declaring them.
  if (s.invariantViolations > 0) out.push(plural(s.invariantViolations, "invariant violation"));
  if (opts.strict) {
    const found = [
      s.consoleErrors > 0 ? plural(s.consoleErrors, "console error") : "",
      s.jsExceptions > 0 ? plural(s.jsExceptions, "JS exception") : "",
      // An escaping rejection is the failure mode this library exists to
      // find, and it used to be the one thing `strict` ignored: a run whose
      // whole finding was "the app left a rejection unhandled" exited 0.
      s.unhandledRejections > 0 ? plural(s.unhandledRejections, "unhandled rejection") : "",
    ].filter(Boolean);
    if (found.length > 0) out.push(`--strict: ${found.join(", ")}`);
  }
  if (opts.http) {
    const floor = HTTP_FLOORS[opts.http];
    const n = (opts.http === "5xx" ? s.httpErrors?.["5xx"] : s.httpErrors?.total) ?? 0;
    if (n > 0) {
      const first = firstError(report, (e) => e.type === "console" && (e.status ?? 0) >= floor);
      const where = first ? ` (first: ${first.method ?? "?"} ${first.resourceUrl} ${first.status} on ${first.url})` : "";
      out.push(`--fail-on-http ${opts.http}: ${n} HTTP response${n === 1 ? "" : "s"} >= ${floor}${where}`);
    }
  }
  if (opts.network && s.networkErrors > 0) {
    const first = firstError(report, (e) => e.type === "network");
    // The message is `<url> - <errorText>`.
    const where = first ? ` (first: ${first.method ? `${first.method} ` : ""}${first.message.replace(" - ", " ")} on ${first.url})` : "";
    out.push(`--fail-on-network: ${plural(s.networkErrors, "network error")}${where}`);
  }
  const dead = s.discovery?.deadLinks ?? [];
  if (opts.deadLinks && dead.length > 0) {
    out.push(`--fail-on-dead-links: ${plural(dead.length, "dead link")}${firstDeadLink(dead)}`);
  }
  const warnings = report.warnings ?? [];
  if (opts.warnings && warnings.length > 0) {
    out.push(`--fail-on-warnings: ${plural(warnings.length, "warning")}${firstWarning(warnings)}`);
  }
  if (opts.baselineStrict && report.diff) {
    const found = [
      report.diff.newClusters.length > 0 ? plural(report.diff.newClusters.length, "new cluster") : "",
      report.diff.newFailedPages.length > 0 ? plural(report.diff.newFailedPages.length, "newly failing page") : "",
    ].filter(Boolean);
    if (found.length > 0) out.push(`--baseline-strict: ${found.join(", ")} vs the baseline`);
  }
  return out;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** ` (first: <url>)` for the first page `which` picks, or nothing for a report without pages. */
function firstUrl(report: ExitCodeReport, which: (page: PageResult) => boolean): string {
  const page = report.pages?.find(which);
  return page ? ` (first: ${page.url})` : "";
}

/** The first error of the report's pages `which` picks that is no fault echo. */
function firstError(report: ExitCodeReport, which: (error: PageError) => boolean): PageError | undefined {
  for (const page of report.pages ?? []) {
    const found = page.errors.find((e) => !isFaultEcho(e) && which(e));
    if (found) return found;
  }
  return undefined;
}

function crashed(page: PageResult): boolean {
  return page.errors.some((e) => e.type === "crash");
}
