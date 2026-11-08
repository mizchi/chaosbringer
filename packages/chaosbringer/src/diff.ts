/**
 * Compute a diff between a baseline report and the current report. The goal is
 * regression detection in CI: surface what's newly broken since the last run
 * while ignoring clusters / pages that were already broken.
 *
 * Clusters are matched by key, recomputed from each cluster's sample with
 * the current `fingerprintError` (see `clusterKeys`); pages are matched by
 * URL. Nothing else is compared.
 */

import { readFileSync } from "node:fs";
import { fingerprintError, type ErrorCluster } from "./clusters.js";
import { CRASHED_PAGE_ERROR, CRAWLER_NAVIGATION_ERROR, RENDERER_CRASHED, stripAnsi } from "./error-text.js";
import { isFaultEcho } from "./resource-outcomes.js";
import type {
  ClusterDiffEntry,
  CrawlReport,
  PageDiffEntry,
  PageError,
  PageResult,
  ReportDiff,
} from "./types.js";

/**
 * A report's clusters by the key the current version gives them. A
 * baseline an older version wrote keyed a cluster by an older
 * fingerprint: with Playwright's call log in it (which named the
 * `waitUntil` of the crawl's `--settle`) and its ANSI colours, and it
 * recorded a failed `page.goto` as an `exception` and a renderer crash as
 * whichever call met the dead page. Compared as written, upgrading
 * reported every such cluster as both new and resolved, and
 * `--baseline-strict` failed. So clusters are matched by a key recomputed
 * from each one's `sample.message`, under the type the current crawler
 * records it as; the entries keep the key the report wrote. Clusters of the
 * older version that are one cluster now are added up, under the first.
 * For a report this version wrote, the recomputed key is its own.
 */
function clusterKeys(report: Pick<CrawlReport, "errorClusters">): Map<string, ErrorCluster> {
  const out = new Map<string, ErrorCluster>();
  for (const c of report.errorClusters) {
    const key = matchKey(c);
    const seen = out.get(key);
    out.set(key, seen ? { ...seen, count: seen.count + c.count, urls: [...new Set([...seen.urls, ...c.urls])] } : c);
  }
  return out;
}

function matchKey(c: ErrorCluster): string {
  const sample = c.sample as PageError | undefined;
  if (!sample || typeof sample.message !== "string") return c.key;
  const message = stripAnsi(sample.message);
  if (c.type === "exception" && CRAWLER_NAVIGATION_ERROR.test(message)) {
    return `navigation|${fingerprintError({ ...sample, type: "navigation" })}`;
  }
  if (c.type === "exception" && CRASHED_PAGE_ERROR.test(message)) {
    return `crash|${fingerprintError({ ...sample, type: "crash", message: RENDERER_CRASHED })}`;
  }
  return `${c.type}|${fingerprintError({ ...sample, type: c.type })}`;
}

/** A page's errors less the echoes of a fault the run injected, which no cluster or count holds either. */
function appErrors(page: Pick<PageResult, "errors">): number {
  return page.errors.filter((e) => !isFaultEcho(e)).length;
}

function pageFailed(page: Pick<PageResult, "status" | "errors">): boolean {
  return appErrors(page) > 0 || page.status === "error" || page.status === "timeout";
}

function pageSummary(page: PageResult): PageDiffEntry["after"] {
  return { errors: appErrors(page), status: page.status };
}

export function diffReports(
  baseline: CrawlReport,
  current: CrawlReport,
  options: { baselinePath?: string } = {}
): ReportDiff {
  const baselineClusters = clusterKeys(baseline);
  const currentClusters = clusterKeys(current);

  const newClusters: ClusterDiffEntry[] = [];
  const resolvedClusters: ClusterDiffEntry[] = [];
  const unchangedClusters: ClusterDiffEntry[] = [];

  for (const [key, curr] of currentClusters) {
    const prev = baselineClusters.get(key);
    const entry: ClusterDiffEntry = {
      key: curr.key,
      type: curr.type,
      fingerprint: curr.fingerprint,
      before: prev?.count ?? 0,
      after: curr.count,
    };
    if (prev) unchangedClusters.push(entry);
    else newClusters.push(entry);
  }
  for (const [key, prev] of baselineClusters) {
    if (currentClusters.has(key)) continue;
    resolvedClusters.push({
      key: prev.key,
      type: prev.type,
      fingerprint: prev.fingerprint,
      before: prev.count,
      after: 0,
    });
  }

  const baselinePages = new Map(baseline.pages.map((p) => [p.url, p]));
  const currentPages = new Map(current.pages.map((p) => [p.url, p]));
  const newFailedPages: PageDiffEntry[] = [];
  const resolvedFailedPages: PageDiffEntry[] = [];

  for (const [url, curr] of currentPages) {
    const prev = baselinePages.get(url);
    const currFailed = pageFailed(curr);
    const prevFailed = prev ? pageFailed(prev) : false;
    if (currFailed && !prevFailed) {
      newFailedPages.push({
        url,
        before: prev ? pageSummary(prev) : null,
        after: pageSummary(curr),
      });
    } else if (!currFailed && prevFailed && prev) {
      resolvedFailedPages.push({
        url,
        before: pageSummary(prev),
        after: pageSummary(curr),
      });
    }
  }
  // Pages that were failing before and weren't revisited — also "resolved"
  // from the current run's perspective (we can't claim they're still broken).
  for (const [url, prev] of baselinePages) {
    if (currentPages.has(url)) continue;
    if (!pageFailed(prev)) continue;
    resolvedFailedPages.push({
      url,
      before: pageSummary(prev),
      after: null,
    });
  }

  return {
    baselinePath: options.baselinePath,
    baselineSeed: baseline.seed,
    newClusters,
    resolvedClusters,
    unchangedClusters,
    newFailedPages,
    resolvedFailedPages,
  };
}

/**
 * Read a baseline report from disk. Returns `null` when the file is missing —
 * callers (CLI / chaos()) treat that as "first run, no baseline yet" and warn.
 * Throws if the file exists but is not a parseable report.
 */
export function loadBaseline(path: string): CrawlReport | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as CrawlReport;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.errorClusters)) {
    throw new Error(`Baseline file is not a chaos report: ${path}`);
  }
  return parsed;
}

/**
 * True when the diff contains regressions worth failing a run over. Used by
 * `--baseline-strict` — a less aggressive default than failing on any diff
 * (which would flag "resolved" pages too).
 */
export function hasRegressions(diff: ReportDiff): boolean {
  return diff.newClusters.length > 0 || diff.newFailedPages.length > 0;
}
