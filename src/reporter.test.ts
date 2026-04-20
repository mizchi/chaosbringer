import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { formatCompactReport, getExitCode, saveReport } from "./reporter.js";
import type { CrawlReport, CrawlSummary } from "./types.js";

function makeSummary(overrides: Partial<CrawlSummary> = {}): CrawlSummary {
  return {
    successPages: 0,
    errorPages: 0,
    timeoutPages: 0,
    recoveredPages: 0,
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
    seed: 42,
    startTime: 0,
    endTime: 1000,
    duration: 1000,
    pagesVisited: 1,
    totalErrors: 0,
    totalWarnings: 0,
    blockedExternalNavigations: 0,
    recoveryCount: 0,
    pages: [],
    actions: [],
    summary: makeSummary(),
    ...overrides,
  };
}

describe("getExitCode", () => {
  it("returns 0 for a clean report", () => {
    expect(getExitCode(makeReport())).toBe(0);
  });

  it("returns 1 when there are error pages", () => {
    expect(getExitCode(makeReport({ summary: makeSummary({ errorPages: 1 }) }))).toBe(1);
  });

  it("returns 1 when there are timeout pages", () => {
    expect(getExitCode(makeReport({ summary: makeSummary({ timeoutPages: 1 }) }))).toBe(1);
  });

  it("returns 0 for console-only errors in non-strict mode", () => {
    expect(getExitCode(makeReport({ summary: makeSummary({ consoleErrors: 5 }) }))).toBe(0);
  });

  it("returns 1 for console errors in strict mode", () => {
    expect(
      getExitCode(makeReport({ summary: makeSummary({ consoleErrors: 1 }) }), true)
    ).toBe(1);
  });

  it("returns 1 for JS exceptions in strict mode", () => {
    expect(
      getExitCode(makeReport({ summary: makeSummary({ jsExceptions: 1 }) }), true)
    ).toBe(1);
  });

  it("returns 0 for clean report in strict mode", () => {
    expect(getExitCode(makeReport(), true)).toBe(0);
  });

  it("returns 1 for invariant violations even in non-strict mode", () => {
    const report = makeReport({ summary: makeSummary({ invariantViolations: 1 }) });
    expect(getExitCode(report)).toBe(1);
    expect(getExitCode(report, true)).toBe(1);
  });
});

describe("formatCompactReport", () => {
  it("shows PASS for clean report", () => {
    const out = formatCompactReport(makeReport({ pagesVisited: 10 }));
    expect(out).toContain("[PASS]");
    expect(out).toContain("10 pages");
  });

  it("shows FAIL when there are error pages", () => {
    const report = makeReport({
      summary: makeSummary({ errorPages: 2, consoleErrors: 3 }),
    });
    const out = formatCompactReport(report);
    expect(out).toContain("[FAIL]");
  });

  it("aggregates error counts", () => {
    const report = makeReport({
      summary: makeSummary({ consoleErrors: 2, networkErrors: 1, jsExceptions: 3 }),
    });
    const out = formatCompactReport(report);
    expect(out).toContain("6 errors");
  });

  it("includes metrics when present", () => {
    const report = makeReport({
      summary: makeSummary({ avgMetrics: { ttfb: 50, fcp: 120, lcp: 200 } }),
    });
    const out = formatCompactReport(report);
    expect(out).toContain("TTFB=50ms");
    expect(out).toContain("FCP=120ms");
  });

  it("omits metrics line when not present", () => {
    const out = formatCompactReport(makeReport());
    expect(out).not.toContain("Metrics");
  });

  it("includes the seed so users can reproduce a run", () => {
    const out = formatCompactReport(makeReport({ seed: 99999 }));
    expect(out).toContain("seed=99999");
  });
});

describe("saveReport", () => {
  it("writes a readable JSON file", () => {
    const path = join(tmpdir(), `chaos-test-${Date.now()}.json`);
    try {
      const report = makeReport({ pagesVisited: 7 });
      saveReport(report, path);
      expect(existsSync(path)).toBe(true);
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      expect(parsed.pagesVisited).toBe(7);
      expect(parsed.baseUrl).toBe("http://localhost:3000");
    } finally {
      if (existsSync(path)) unlinkSync(path);
    }
  });
});
