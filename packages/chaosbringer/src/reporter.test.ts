import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { formatCompactReport, formatReport, getExitCode, saveReport } from "./reporter.js";
import type { CrawlReport, CrawlSummary } from "./types.js";

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
    seed: 42,
    reproCommand: "chaosbringer --url http://localhost:3000 --seed 42",
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
    errorClusters: [],
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

  it("reports FAIL in strict mode when console errors exist (matching getExitCode)", () => {
    const report = makeReport({ summary: makeSummary({ consoleErrors: 1 }) });
    expect(formatCompactReport(report)).toContain("[PASS]");
    expect(formatCompactReport(report, true)).toContain("[FAIL]");
  });

  it("reports FAIL when any invariant violated, regardless of strict", () => {
    const report = makeReport({ summary: makeSummary({ invariantViolations: 1 }) });
    expect(formatCompactReport(report)).toContain("[FAIL]");
    expect(formatCompactReport(report, true)).toContain("[FAIL]");
  });

  it("appends advisor=succeeded/attempted suffix when advisor was used", () => {
    const report = makeReport({
      advisor: {
        provider: "openrouter/google/gemini-2.5-flash",
        callsAttempted: 5,
        callsSucceeded: 4,
        picks: [],
      },
    });
    expect(formatCompactReport(report)).toContain("advisor=4/5");
  });

  it("omits advisor suffix when advisor was configured but never consulted", () => {
    const report = makeReport({
      advisor: {
        provider: "openrouter/google/gemini-2.5-flash",
        callsAttempted: 0,
        callsSucceeded: 0,
        picks: [],
      },
    });
    expect(formatCompactReport(report)).not.toContain("advisor=");
  });
});

describe("formatReport", () => {
  it("includes a VLM ADVISOR section when advisor was used", () => {
    const report = makeReport({
      advisor: {
        provider: "openrouter/google/gemini-2.5-flash",
        callsAttempted: 3,
        callsSucceeded: 3,
        picks: [
          { url: "/a", reason: "novelty_stall", chosenSelector: "#a", reasoning: "x" },
          { url: "/b", reason: "novelty_stall", chosenSelector: "#b", reasoning: "y" },
          { url: "/c", reason: "invariant_violation", chosenSelector: "#c", reasoning: "z" },
        ],
      },
    });
    const out = formatReport(report);
    expect(out).toContain("VLM ADVISOR");
    expect(out).toContain("openrouter/google/gemini-2.5-flash");
    expect(out).toContain("3/3 succeeded");
    expect(out).toContain("novelty_stall=2");
    expect(out).toContain("invariant_violation=1");
  });

  it("omits the advisor section when advisor was never consulted", () => {
    const out = formatReport(makeReport());
    expect(out).not.toContain("VLM ADVISOR");
  });

  it("includes a REPLAY FIDELITY section when traceReplay was used", () => {
    const report = makeReport({
      replayFidelity: {
        totalActions: 10,
        succeeded: 7,
        selectorMissing: 2,
        noSelectorRecorded: 1,
        threw: 0,
      },
    });
    const out = formatReport(report);
    expect(out).toContain("REPLAY FIDELITY");
    expect(out).toContain("7/10 actions replayed cleanly (70.0%)");
    expect(out).toContain("selectorMissing=2");
    expect(out).toContain("noSelectorRecorded=1");
    expect(out).toContain("threw=0");
  });

  it("omits the drift breakdown when replay was 100% clean", () => {
    const report = makeReport({
      replayFidelity: {
        totalActions: 5,
        succeeded: 5,
        selectorMissing: 0,
        noSelectorRecorded: 0,
        threw: 0,
      },
    });
    const out = formatReport(report);
    expect(out).toContain("REPLAY FIDELITY");
    expect(out).toContain("5/5 actions replayed cleanly (100.0%)");
    expect(out).not.toContain("drift breakdown");
  });

  it("omits the replay-fidelity section when traceReplay was not used", () => {
    const out = formatReport(makeReport());
    expect(out).not.toContain("REPLAY FIDELITY");
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
