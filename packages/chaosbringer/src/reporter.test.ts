import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync, unlinkSync, rmSync } from "node:fs";
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

  it("creates missing parent directories before writing", () => {
    const rootDir = join(tmpdir(), `chaos-test-mkdir-${Date.now()}`);
    const path = join(rootDir, "nested", "deep", "report.json");
    try {
      const report = makeReport({ pagesVisited: 3 });
      saveReport(report, path);
      expect(existsSync(path)).toBe(true);
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      expect(parsed.pagesVisited).toBe(3);
    } finally {
      if (existsSync(rootDir)) rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("formatReport: fault injection block", () => {
  it("names a suppressed decision, and says nothing when there was none", () => {
    const text = formatReport(
      makeReport({
        faultInjections: [
          { rule: "first", matched: 3, injected: 2 },
          { rule: "second", matched: 3, injected: 0, suppressed: 1 },
        ],
      }),
    );
    expect(text).toContain("first: matched=3 injected=2");
    expect(text).toContain("second: matched=3 injected=0 suppressed=1");
    // Not a column on every row: `suppressed=0` everywhere is a column a
    // reader learns to skip, which is the opposite of the point.
    expect(text).not.toContain("first: matched=3 injected=2 suppressed=0");
  });

  it("shows held requests, which used to be JSON-only", () => {
    // The parked request is the point of an unbounded hang *and* the reason
    // for whatever navigation timeout is printed above it.
    const held = formatReport(
      makeReport({
        faultInjections: [{ rule: "hang", matched: 1, injected: 1 }],
        heldRequests: 2,
      }),
    );
    expect(held).toMatch(/requests held open.*: 2/);
    const none = formatReport(
      makeReport({ faultInjections: [{ rule: "x", matched: 1, injected: 1 }] }),
    );
    expect(none).not.toMatch(/requests held open/);
  });
});

describe("getExitCode and an escaping rejection", () => {
  const withRejections = (n: number) =>
    makeReport({
      summary: { ...makeReport().summary, unhandledRejections: n },
    });

  it("fails under strict, because that is the finding this library is for", () => {
    // It used to exit 0: a run whose entire result was "the app left a
    // rejection unhandled" reported success, while a single `console.error`
    // failed.
    expect(getExitCode(withRejections(1), true)).toBe(1);
    expect(getExitCode(withRejections(1), { strict: true })).toBe(1);
  });

  it("stays quiet without strict, like console errors do", () => {
    expect(getExitCode(withRejections(1))).toBe(0);
  });

  it("does not fail a clean run under strict", () => {
    expect(getExitCode(withRejections(0), true)).toBe(0);
  });
});
