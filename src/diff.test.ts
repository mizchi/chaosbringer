import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ErrorCluster } from "./clusters.js";
import { diffReports, hasRegressions, loadBaseline } from "./diff.js";
import { getExitCode } from "./reporter.js";
import type { CrawlReport, CrawlSummary, PageError, PageResult } from "./types.js";

function cluster(overrides: Partial<ErrorCluster> & { key: string; fingerprint: string }): ErrorCluster {
  const sample: PageError = { type: "console", message: overrides.fingerprint, timestamp: 0 };
  return {
    key: overrides.key,
    type: overrides.type ?? "console",
    fingerprint: overrides.fingerprint,
    sample,
    count: overrides.count ?? 1,
    urls: overrides.urls ?? [],
    invariantNames: overrides.invariantNames,
  };
}

function page(overrides: Partial<PageResult> & { url: string }): PageResult {
  return {
    url: overrides.url,
    status: overrides.status ?? "success",
    loadTime: 0,
    errors: overrides.errors ?? [],
    hasErrors: (overrides.errors ?? []).length > 0,
    warnings: [],
    links: [],
    ...overrides,
  };
}

function makeSummary(overrides: Partial<CrawlSummary> = {}): CrawlSummary {
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
    ...overrides,
  };
}

function makeReport(overrides: Partial<CrawlReport> = {}): CrawlReport {
  return {
    baseUrl: "http://localhost:3000",
    seed: 1,
    reproCommand: "chaosbringer",
    startTime: 0,
    endTime: 0,
    duration: 0,
    pagesVisited: 0,
    totalErrors: 0,
    totalWarnings: 0,
    blockedExternalNavigations: 0,
    recoveryCount: 0,
    pages: [],
    actions: [],
    summary: makeSummary(),
    errorClusters: [],
    ...overrides,
  };
}

describe("diffReports", () => {
  it("surfaces clusters present only in the current run as new", () => {
    const prev = makeReport({ errorClusters: [cluster({ key: "console|old", fingerprint: "old", count: 3 })] });
    const curr = makeReport({
      errorClusters: [
        cluster({ key: "console|old", fingerprint: "old", count: 3 }),
        cluster({ key: "console|new", fingerprint: "new", count: 2 }),
      ],
    });
    const diff = diffReports(prev, curr);
    expect(diff.newClusters.map((c) => c.key)).toEqual(["console|new"]);
    expect(diff.newClusters[0]!.before).toBe(0);
    expect(diff.newClusters[0]!.after).toBe(2);
    expect(diff.unchangedClusters.map((c) => c.key)).toEqual(["console|old"]);
  });

  it("surfaces clusters gone from the current run as resolved", () => {
    const prev = makeReport({
      errorClusters: [
        cluster({ key: "console|gone", fingerprint: "gone", count: 5 }),
        cluster({ key: "console|kept", fingerprint: "kept", count: 1 }),
      ],
    });
    const curr = makeReport({ errorClusters: [cluster({ key: "console|kept", fingerprint: "kept", count: 1 })] });
    const diff = diffReports(prev, curr);
    expect(diff.resolvedClusters.map((c) => c.key)).toEqual(["console|gone"]);
    expect(diff.resolvedClusters[0]!.before).toBe(5);
    expect(diff.resolvedClusters[0]!.after).toBe(0);
  });

  it("carries baselineSeed and baselinePath through", () => {
    const prev = makeReport({ seed: 999 });
    const curr = makeReport({ seed: 1 });
    const diff = diffReports(prev, curr, { baselinePath: "/tmp/prev.json" });
    expect(diff.baselineSeed).toBe(999);
    expect(diff.baselinePath).toBe("/tmp/prev.json");
  });

  it("flags a page that was clean but is now failing", () => {
    const err: PageError = { type: "console", message: "boom", timestamp: 0 };
    const prev = makeReport({ pages: [page({ url: "http://x/a", status: "success" })] });
    const curr = makeReport({ pages: [page({ url: "http://x/a", status: "success", errors: [err] })] });
    const diff = diffReports(prev, curr);
    expect(diff.newFailedPages.map((p) => p.url)).toEqual(["http://x/a"]);
    expect(diff.newFailedPages[0]!.before?.errors).toBe(0);
    expect(diff.newFailedPages[0]!.after?.errors).toBe(1);
    expect(diff.resolvedFailedPages).toHaveLength(0);
  });

  it("flags a page that was failing but is now clean as resolved", () => {
    const err: PageError = { type: "console", message: "boom", timestamp: 0 };
    const prev = makeReport({ pages: [page({ url: "http://x/a", status: "error", errors: [err] })] });
    const curr = makeReport({ pages: [page({ url: "http://x/a", status: "success" })] });
    const diff = diffReports(prev, curr);
    expect(diff.resolvedFailedPages.map((p) => p.url)).toEqual(["http://x/a"]);
    expect(diff.newFailedPages).toHaveLength(0);
  });

  it("treats URLs new to this run as new if they fail, ignores them if clean", () => {
    const err: PageError = { type: "console", message: "x", timestamp: 0 };
    const prev = makeReport({ pages: [] });
    const curr = makeReport({
      pages: [
        page({ url: "http://x/new-fail", status: "error", errors: [err] }),
        page({ url: "http://x/new-ok", status: "success" }),
      ],
    });
    const diff = diffReports(prev, curr);
    expect(diff.newFailedPages.map((p) => p.url)).toEqual(["http://x/new-fail"]);
    expect(diff.newFailedPages[0]!.before).toBeNull();
  });

  it("counts pages that failed before but were not revisited as resolved", () => {
    const err: PageError = { type: "console", message: "x", timestamp: 0 };
    const prev = makeReport({ pages: [page({ url: "http://x/gone", status: "error", errors: [err] })] });
    const curr = makeReport({ pages: [] });
    const diff = diffReports(prev, curr);
    expect(diff.resolvedFailedPages.map((p) => p.url)).toEqual(["http://x/gone"]);
    expect(diff.resolvedFailedPages[0]!.after).toBeNull();
  });
});

describe("hasRegressions", () => {
  it("is true when there are new clusters", () => {
    const diff = diffReports(
      makeReport(),
      makeReport({ errorClusters: [cluster({ key: "k", fingerprint: "f" })] })
    );
    expect(hasRegressions(diff)).toBe(true);
  });

  it("is false when only clusters resolve", () => {
    const diff = diffReports(
      makeReport({ errorClusters: [cluster({ key: "k", fingerprint: "f" })] }),
      makeReport()
    );
    expect(hasRegressions(diff)).toBe(false);
  });
});

describe("loadBaseline", () => {
  it("returns null when the file does not exist", () => {
    expect(loadBaseline(join(tmpdir(), `missing-${Date.now()}-${Math.random()}.json`))).toBeNull();
  });

  it("reads a valid report", () => {
    const dir = mkdtempSync(join(tmpdir(), "chaos-diff-"));
    try {
      const path = join(dir, "baseline.json");
      writeFileSync(path, JSON.stringify(makeReport({ seed: 42 })));
      const loaded = loadBaseline(path);
      expect(loaded?.seed).toBe(42);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on malformed JSON content", () => {
    const dir = mkdtempSync(join(tmpdir(), "chaos-diff-"));
    try {
      const path = join(dir, "garbage.json");
      writeFileSync(path, "{}"); // valid JSON but not a report (missing errorClusters)
      expect(() => loadBaseline(path)).toThrow(/not a chaos report/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("getExitCode with baselineStrict", () => {
  it("returns 1 when baselineStrict and the diff has new clusters", () => {
    const report = makeReport({
      diff: {
        baselineSeed: 0,
        newClusters: [{ key: "k", type: "console", fingerprint: "f", before: 0, after: 1 }],
        resolvedClusters: [],
        unchangedClusters: [],
        newFailedPages: [],
        resolvedFailedPages: [],
      },
    });
    expect(getExitCode(report, { baselineStrict: true })).toBe(1);
    expect(getExitCode(report, { baselineStrict: false })).toBe(0);
  });

  it("returns 0 when baselineStrict but the diff is clean", () => {
    const report = makeReport({
      diff: {
        baselineSeed: 0,
        newClusters: [],
        resolvedClusters: [{ key: "k", type: "console", fingerprint: "f", before: 1, after: 0 }],
        unchangedClusters: [],
        newFailedPages: [],
        resolvedFailedPages: [],
      },
    });
    expect(getExitCode(report, { baselineStrict: true })).toBe(0);
  });

  it("still accepts a bare boolean for the legacy strict flag", () => {
    const report = makeReport({ summary: makeSummary({ consoleErrors: 1 }) });
    expect(getExitCode(report, true)).toBe(1);
    expect(getExitCode(report, false)).toBe(0);
  });
});
