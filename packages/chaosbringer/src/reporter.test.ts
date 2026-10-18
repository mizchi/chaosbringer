import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { exitReasons, formatCompactReport, formatReport, getExitCode, saveReport } from "./reporter.js";
import { fakeAction, fakePage, fakeSpan } from "./perf-fixtures.test-helpers.js";
import { buildCrawlPerfSummary } from "./perf-summary.js";
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

describe("exitReasons", () => {
  it("names every rule that fails the run, and nothing for a passing one", () => {
    const report = makeReport({
      pages: [
        fakePage("http://localhost:3000/ok"),
        fakePage("http://localhost:3000/down", undefined, { status: "error" }),
        fakePage("http://localhost:3000/slow", undefined, { status: "timeout" }),
      ],
      summary: makeSummary({
        errorPages: 1,
        timeoutPages: 1,
        invariantViolations: 2,
        consoleErrors: 1,
        jsExceptions: 3,
        unhandledRejections: 1,
      }),
      diff: {
        newClusters: [{ key: "console|x", type: "console", fingerprint: "x", before: 0, after: 1 }],
        resolvedClusters: [],
        unchangedClusters: [],
        newFailedPages: [],
        resolvedFailedPages: [],
      },
    });
    expect(exitReasons(report, { strict: true, baselineStrict: true })).toEqual([
      "1 page failed to load (first: http://localhost:3000/down)",
      "1 page timed out (first: http://localhost:3000/slow)",
      "2 invariant violations",
      "--strict: 1 console error, 3 JS exceptions, 1 unhandled rejection",
      "--baseline-strict: 1 new cluster vs the baseline",
    ]);
    // Without the flags, only the rules that always apply.
    expect(exitReasons(report)).toHaveLength(3);
    expect(exitReasons(makeReport({ summary: makeSummary({ consoleErrors: 5 }) }))).toEqual([]);
  });

  it("judges a report without pages, as the fixture's testPage() passes one", () => {
    // The Playwright fixture's strict check hands over a summary alone; the
    // verdict is the same, only the first failing URL goes unnamed.
    const run = { summary: makeSummary({ errorPages: 1 }) };
    expect(exitReasons(run)).toEqual(["1 page failed to load"]);
    expect(getExitCode(run)).toBe(1);
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

  it("counts the rejections and invariant violations a run fails on", () => {
    // The dogfood case: `--strict --compact` on a page whose only finding is
    // an unhandled rejection printed `[FAIL] 1 pages, 0 errors`.
    const rejection = makeReport({ summary: makeSummary({ unhandledRejections: 1 }) });
    expect(formatCompactReport(rejection, true)).toMatch(/^\[FAIL\] 1 pages, 1 errors,/);
    const violations = makeReport({ summary: makeSummary({ consoleErrors: 1, invariantViolations: 2 }) });
    expect(formatCompactReport(violations)).toMatch(/^\[FAIL\] 1 pages, 3 errors,/);
  });

  it("on FAIL says which rule failed, the top three clusters and the repro command", () => {
    const clusters = ["a", "b", "c", "d"].map((name, i) => ({
      key: `unhandled-rejection|boom ${name}`,
      type: "unhandled-rejection" as const,
      fingerprint: `boom ${name}`,
      sample: { type: "unhandled-rejection" as const, message: `boom ${name}`, timestamp: 0 },
      count: 4 - i,
      urls: ["http://localhost:3000/"],
    }));
    const report = makeReport({
      summary: makeSummary({ unhandledRejections: 10 }),
      errorClusters: clusters,
      reproCommand: "chaosbringer --url http://localhost:3000 --seed 42 --strict",
    });
    expect(formatCompactReport(report, true).split("\n")).toEqual([
      "[FAIL] 1 pages, 10 errors, 1.0s (seed=42)",
      "  Failed: --strict: 10 unhandled rejections",
      "  Top clusters:",
      "    [unhandled-rejection]×4 boom a",
      "    [unhandled-rejection]×3 boom b",
      "    [unhandled-rejection]×2 boom c",
      "    … and 1 more",
      "  Repro: chaosbringer --url http://localhost:3000 --seed 42 --strict",
    ]);
    // A passing run stays one line: nothing failed, so nothing to explain.
    expect(formatCompactReport(report).split("\n")).toEqual(["[PASS] 1 pages, 10 errors, 1.0s (seed=42)"]);
  });

  it("on FAIL lists the clusters that failed the run before larger ones that did not", () => {
    const cluster = (type: "console" | "network" | "exception", fingerprint: string, count: number) => ({
      key: `${type}|${fingerprint}`,
      type,
      fingerprint,
      sample: { type, message: fingerprint, timestamp: 0 },
      count,
      urls: ["http://localhost:3000/"],
    });
    const unchanged = [cluster("console", "old a", 9), cluster("console", "old b", 8), cluster("console", "old c", 7)];
    const boom = cluster("exception", "fixture: boom", 1);
    const entry = (c: ReturnType<typeof cluster>) => ({ ...c, before: c.count, after: c.count });
    // The PR gate's case: only the small new cluster fails --baseline-strict.
    const gated = makeReport({
      summary: makeSummary({ consoleErrors: 24, jsExceptions: 1 }),
      errorClusters: [...unchanged, boom],
      diff: {
        baselineSeed: 1,
        newClusters: [{ ...entry(boom), before: 0 }],
        resolvedClusters: [],
        unchangedClusters: unchanged.map(entry),
        newFailedPages: [],
        resolvedFailedPages: [],
      },
    });
    expect(formatCompactReport(gated, { baselineStrict: true }).split("\n").slice(1, 5)).toEqual([
      "  Failed: --baseline-strict: 1 new cluster vs the baseline",
      "  Top clusters:",
      "    [exception] fixture: boom (new)",
      "    [console]×9 old a",
    ]);
    // --strict does not fail on network errors, however many there are.
    const strict = makeReport({
      summary: makeSummary({ networkErrors: 27, jsExceptions: 1 }),
      errorClusters: [cluster("network", "net a", 9), cluster("network", "net b", 9), cluster("network", "net c", 9), boom],
    });
    expect(formatCompactReport(strict, true).split("\n")[3]).toBe("    [exception] fixture: boom");
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

describe("formatReport: failed resources", () => {
  it("names the file under a failed load, on its page and under its cluster", () => {
    const message = "Failed to load resource: the server responded with a status of 404 (Not Found)";
    const files = [1, 2, 3, 4, 5, 6, 7].map((i) => `http://x/img/${i}.png`);
    const error = { type: "console" as const, message, url: "http://x/", timestamp: 0, resourceUrl: files[0] };
    const text = formatReport(
      makeReport({
        pages: [fakePage("http://x/", undefined, { errors: [error, { type: "console", message: "app log", url: "http://x/", timestamp: 0 }] })],
        errorClusters: [
          { key: `console|${message}`, type: "console", fingerprint: message, sample: error, count: 7, urls: ["http://x/"], resourceUrls: files },
        ],
      }),
    );
    // Under the page's error line: the message alone does not say which file.
    expect(text).toContain(`  [console] ${message}\n    resource: ${files[0]}\n  [console] app log\n`);
    // Under the cluster: the first five, then how many more the JSON has.
    const listed = files
      .slice(0, 5)
      .map((u) => `    resource: ${u}\n`)
      .join("");
    expect(text).toContain(`  [console]×7 ${message}\n${listed}    … and 2 more\n`);
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

describe("formatReport perf-under-chaos lines", () => {
  it("prints degradation, coverage and trends only when present", () => {
    const k = "/item/:id :: load";
    const pages = [
      fakePage("http://x/item/1", fakeSpan(k, { durationMs: 450, requestCount: 3, faults: ["api-delay"] })),
      fakePage("http://x/item/2", fakeSpan(k, { durationMs: 100, requestCount: 2 })),
    ];
    const mem = (n: number) => ({ jsEventListeners: n, jsHeapUsedMB: 1, domNodes: 10, arrayBuffers: 0 });
    const actions = [20, 60, 100, 140].map((n, i) => ({
      ...fakeAction(fakeSpan("/app :: click #nav", { memory: mem(n) })),
      timestamp: i,
    }));
    const perf = buildCrawlPerfSummary(pages, actions, {
      coverage: { js: [{ url: "http://x/app.js", total: 1000, used: [[0, 250]] }] },
    });
    const text = formatReport(makeReport({ pages, actions, perf }));
    expect(text).toContain("Degradation under faults (median with vs without):");
    expect(text).toMatch(/\+350ms {2}\/item\/:id :: load {2}under api-delay {2}\(450ms n=1 vs 100ms n=1\) {2}\+1 req/);
    expect(text).toContain("JS coverage (union over the crawl): 25% used, least used http://x/app.js (25%)");
    expect(text).toContain("Memory climbing across repeats of a step (likely leak):");
    expect(text).toContain("jsEventListeners +120 over 4 repeats (20 -> 140)  /app :: click #nav");

    // A click whose fetch networkidle did not wait for: the lead number is the
    // effective delta, the span's own wall-time delta follows it.
    const clickKey = "/items/:id :: click Reload";
    const clickPages = [
      fakePage("http://x/items/1", fakeSpan(clickKey, { durationMs: 5, settledMs: 310, faults: ["api-delay-300"] })),
      fakePage("http://x/items/2", fakeSpan(clickKey, { durationMs: 20, settledMs: 12 })),
    ];
    const clickText = formatReport(makeReport({ pages: clickPages, perf: buildCrawlPerfSummary(clickPages, []) }));
    expect(clickText).toMatch(
      /\+290ms {2}\/items\/:id :: click Reload {2}under api-delay-300 {2}\(310ms n=1 vs 20ms n=1\) {2}span -15ms/,
    );

    // A span delta that rounds to zero from below still carries a sign.
    const nearZeroPages = [
      fakePage("http://x/items/1", fakeSpan(clickKey, { durationMs: 19.6, settledMs: 310, faults: ["api-delay-300"] })),
      fakePage("http://x/items/2", fakeSpan(clickKey, { durationMs: 20, settledMs: 12 })),
    ];
    const nearZeroText = formatReport(makeReport({ pages: nearZeroPages, perf: buildCrawlPerfSummary(nearZeroPages, []) }));
    expect(nearZeroText).toMatch(/under api-delay-300 .*span \+0ms/);

    const plain = formatReport(makeReport({ pages: [pages[1]!], perf: buildCrawlPerfSummary([pages[1]!], []) }));
    expect(plain).not.toContain("Degradation under faults");
    expect(plain).not.toContain("coverage (union");
    expect(plain).not.toContain("Memory climbing");
  });
});
