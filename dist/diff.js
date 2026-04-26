/**
 * Compute a diff between a baseline report and the current report. The goal is
 * regression detection in CI: surface what's newly broken since the last run
 * while ignoring clusters / pages that were already broken.
 *
 * Clusters are matched by `ErrorCluster.key` (already fingerprinted, stable
 * across runs); pages are matched by URL. Nothing else is compared.
 */
import { readFileSync } from "node:fs";
function pageFailed(page) {
    return page.errors.length > 0 || page.status === "error" || page.status === "timeout";
}
function pageSummary(page) {
    return { errors: page.errors.length, status: page.status };
}
export function diffReports(baseline, current, options = {}) {
    const baselineClusters = new Map(baseline.errorClusters.map((c) => [c.key, c]));
    const currentClusters = new Map(current.errorClusters.map((c) => [c.key, c]));
    const newClusters = [];
    const resolvedClusters = [];
    const unchangedClusters = [];
    for (const [key, curr] of currentClusters) {
        const prev = baselineClusters.get(key);
        const entry = {
            key,
            type: curr.type,
            fingerprint: curr.fingerprint,
            before: prev?.count ?? 0,
            after: curr.count,
        };
        if (prev)
            unchangedClusters.push(entry);
        else
            newClusters.push(entry);
    }
    for (const [key, prev] of baselineClusters) {
        if (currentClusters.has(key))
            continue;
        resolvedClusters.push({
            key,
            type: prev.type,
            fingerprint: prev.fingerprint,
            before: prev.count,
            after: 0,
        });
    }
    const baselinePages = new Map(baseline.pages.map((p) => [p.url, p]));
    const currentPages = new Map(current.pages.map((p) => [p.url, p]));
    const newFailedPages = [];
    const resolvedFailedPages = [];
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
        }
        else if (!currFailed && prevFailed && prev) {
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
        if (currentPages.has(url))
            continue;
        if (!pageFailed(prev))
            continue;
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
export function loadBaseline(path) {
    let raw;
    try {
        raw = readFileSync(path, "utf-8");
    }
    catch (err) {
        const code = err?.code;
        if (code === "ENOENT")
            return null;
        throw err;
    }
    const parsed = JSON.parse(raw);
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
export function hasRegressions(diff) {
    return diff.newClusters.length > 0 || diff.newFailedPages.length > 0;
}
