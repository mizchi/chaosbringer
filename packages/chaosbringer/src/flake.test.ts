import { describe, expect, it } from "vitest";
import type { ErrorCluster } from "./clusters.js";
import { flakeReport, formatFlakeReport } from "./flake.js";
import type { CrawlReport, CrawlSummary, PageError, PageResult } from "./types.js";

function summary(over: Partial<CrawlSummary> = {}): CrawlSummary {
  return {
    successPages: 0,
    errorPages: 0,
    timeoutPages: 0,
    recoveredPages: 0,
    pagesWithErrors: 0,
    consoleErrors: 0,
    networkErrors: 0,
    jsExceptions: 0,
    unhandledRejections: 0,
    invariantViolations: 0,
    avgLoadTime: 0,
    ...over,
  };
}

function cluster(key: string, count: number): ErrorCluster {
  const sample: PageError = { type: "console", message: key, timestamp: 0 };
  return { key, type: "console", fingerprint: key, sample, count, urls: [] };
}

function page(over: Partial<PageResult> & { url: string }): PageResult {
  return {
    url: over.url,
    status: over.status ?? "success",
    loadTime: 0,
    errors: over.errors ?? [],
    hasErrors: (over.errors ?? []).length > 0,
    warnings: [],
    links: [],
    ...over,
  };
}

function makeReport(over: Partial<CrawlReport> = {}): CrawlReport {
  return {
    baseUrl: "http://x/",
    seed: 1,
    reproCommand: "",
    startTime: 0,
    endTime: 0,
    duration: 100,
    pagesVisited: 0,
    totalErrors: 0,
    totalWarnings: 0,
    blockedExternalNavigations: 0,
    recoveryCount: 0,
    pages: [],
    actions: [],
    summary: summary(),
    errorClusters: [],
    ...over,
  };
}

describe("flakeReport", () => {
  it("labels clusters that fire in every run as stable", () => {
    const r = [
      makeReport({ errorClusters: [cluster("k1", 2)] }),
      makeReport({ errorClusters: [cluster("k1", 3)] }),
      makeReport({ errorClusters: [cluster("k1", 1)] }),
    ];
    const analysis = flakeReport(r);
    expect(analysis.runs).toBe(3);
    expect(analysis.stableClusters.map((c) => c.key)).toEqual(["k1"]);
    expect(analysis.stableClusters[0]!.perRunCounts).toEqual([2, 3, 1]);
    expect(analysis.flakyClusters).toEqual([]);
  });

  it("labels clusters that fire in some but not all runs as flaky", () => {
    const r = [
      makeReport({ errorClusters: [cluster("k1", 2), cluster("k2", 1)] }),
      makeReport({ errorClusters: [cluster("k1", 2)] }),
      makeReport({ errorClusters: [cluster("k1", 2), cluster("k2", 1)] }),
    ];
    const analysis = flakeReport(r);
    expect(analysis.stableClusters.map((c) => c.key)).toEqual(["k1"]);
    expect(analysis.flakyClusters.map((c) => c.key)).toEqual(["k2"]);
    expect(analysis.flakyClusters[0]!.runsWithCluster).toBe(2);
    expect(analysis.flakyClusters[0]!.perRunCounts).toEqual([1, 0, 1]);
  });

  it("only reports a page as flaky when its outcome varies across visits", () => {
    const err: PageError = { type: "console", message: "x", timestamp: 0 };
    const reports = [
      makeReport({ pages: [page({ url: "http://x/a", errors: [err] })] }),
      makeReport({ pages: [page({ url: "http://x/a", errors: [] })] }),
      makeReport({ pages: [page({ url: "http://x/a", errors: [err] })] }),
    ];
    const analysis = flakeReport(reports);
    expect(analysis.flakyPages.map((p) => p.url)).toEqual(["http://x/a"]);
    expect(analysis.flakyPages[0]!.failedInRuns).toBe(2);
    expect(analysis.flakyPages[0]!.visitedInRuns).toBe(3);
  });

  it("does not flag pages that fail in every run as flaky", () => {
    const err: PageError = { type: "console", message: "x", timestamp: 0 };
    const reports = [
      makeReport({ pages: [page({ url: "http://x/a", errors: [err] })] }),
      makeReport({ pages: [page({ url: "http://x/a", errors: [err] })] }),
    ];
    expect(flakeReport(reports).flakyPages).toEqual([]);
  });

  it("returns an empty analysis for zero runs", () => {
    expect(flakeReport([])).toEqual({
      runs: 0,
      stableClusters: [],
      flakyClusters: [],
      flakyPages: [],
      durations: [],
    });
  });

  it("preserves input order for durations", () => {
    const reports = [makeReport({ duration: 100 }), makeReport({ duration: 50 }), makeReport({ duration: 200 })];
    expect(flakeReport(reports).durations).toEqual([100, 50, 200]);
  });
});

describe("formatFlakeReport", () => {
  it("includes the run count, stable / flaky counts, and duration stats", () => {
    const reports = [
      makeReport({ duration: 100, errorClusters: [cluster("stable", 1)] }),
      makeReport({ duration: 200, errorClusters: [cluster("stable", 1), cluster("flaky", 1)] }),
    ];
    const out = formatFlakeReport(flakeReport(reports));
    expect(out).toContain("FLAKE REPORT — 2 runs");
    expect(out).toContain("Stable clusters (fire every run): 1");
    expect(out).toContain("Flaky clusters (fire in some runs): 1");
    expect(out).toContain("Duration (ms): avg=150");
  });
});
