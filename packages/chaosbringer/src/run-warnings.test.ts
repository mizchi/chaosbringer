import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compositeDriver, samplingDriver } from "./drivers/composite.js";
import { flowDriver } from "./drivers/flow-driver.js";
import type { DriverStep } from "./drivers/types.js";
import { isWebSocketOnlyPattern } from "./fault-router.js";
import { faultRunWarnings, faultWarnings, unfiredFaults } from "./firings.js";
import { buildGithubAnnotations } from "./github.js";
import { exitReasons, formatCompactReport, formatQuietReport, formatReport, getExitCode } from "./reporter.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addRunWarning,
  applyBaseline,
  END_STATE_WARNING_CODES,
  mergeRunWarnings,
  RUN_WARNING_CODES,
  warningsRaisedSince,
  type RunWarning,
} from "./run-warnings.js";
import { mergeReports } from "./shard.js";
import type { CrawlReport, CrawlSummary } from "./types.js";

function summary(): CrawlSummary {
  return {
    successPages: 1,
    errorPages: 0,
    timeoutPages: 0,
    recoveredPages: 0,
    pagesWithErrors: 0,
    consoleErrors: 0,
    networkErrors: 0,
    jsExceptions: 0,
    crashes: 0,
    unhandledRejections: 0,
    invariantViolations: 0,
    avgLoadTime: 0,
  };
}

function report(over: Partial<CrawlReport> = {}): CrawlReport {
  return {
    baseUrl: "http://x/",
    seed: 1,
    reproCommand: "chaosbringer --url http://x/ --seed 1",
    startTime: 0,
    endTime: 1000,
    duration: 1000,
    pagesVisited: 1,
    totalErrors: 0,
    totalWarnings: 0,
    blockedExternalNavigations: 0,
    recoveryCount: 0,
    pages: [{ url: "http://x/", status: "success", loadTime: 1, errors: [], warnings: [], links: [] }],
    actions: [],
    summary: summary(),
    errorClusters: [],
    ...over,
  };
}

const sitemap: RunWarning = {
  code: "sitemap-unreadable",
  message: "sitemap ./nope.xml could not be read (ENOENT), so the crawl started from the base URL alone",
  count: 1,
  source: "./nope.xml",
};

describe("addRunWarning / mergeRunWarnings", () => {
  it("folds an identical warning into the first, adding to its count", () => {
    const list: RunWarning[] = [];
    addRunWarning(list, { code: "network-profile-failed", message: "m", url: "http://x/a" });
    addRunWarning(list, { code: "network-profile-failed", message: "m", url: "http://x/b" });
    addRunWarning(list, { code: "network-profile-failed", message: "other" });
    expect(list).toEqual([
      { code: "network-profile-failed", message: "m", url: "http://x/a", count: 2 },
      { code: "network-profile-failed", message: "other", count: 1 },
    ]);
  });

  it("keeps two codes with the same message apart", () => {
    const list: RunWarning[] = [];
    addRunWarning(list, { code: "driver-threw", message: "m" });
    addRunWarning(list, { code: "driver-out-of-range", message: "m" });
    expect(list).toHaveLength(2);
  });

  it("merges runs in first-seen order, counts added, an older report's missing list adding nothing", () => {
    const merged = mergeRunWarnings([[sitemap], undefined, [{ ...sitemap, count: 2 }, { code: "flow-incomplete", message: "f", count: 1 }]]);
    expect(merged).toEqual([
      { ...sitemap, count: 3 },
      { code: "flow-incomplete", message: "f", count: 1 },
    ]);
    // The inputs are left as they were.
    expect(sitemap.count).toBe(1);
  });

  it("lists every code once", () => {
    expect(new Set(RUN_WARNING_CODES).size).toBe(RUN_WARNING_CODES.length);
    for (const code of END_STATE_WARNING_CODES) expect(RUN_WARNING_CODES).toContain(code);
  });
});

describe("warningsRaisedSince", () => {
  const threw: RunWarning = { code: "lifecycle-fault-failed", message: "t", count: 1 };
  const unmatched: RunWarning = { code: "fault-unmatched", message: "u", count: 1, rule: "r" };

  // The fixture's testPage(): a rule aimed at the test's next page has not
  // fired yet, which is not this page's finding.
  it("is what the run raised in between, not what its end state says so far", () => {
    expect(warningsRaisedSince([], [unmatched, threw])).toEqual([threw]);
    expect(warningsRaisedSince([threw], [unmatched, { ...threw, count: 3 }])).toEqual([{ ...threw, count: 2 }]);
    expect(warningsRaisedSince([threw], [threw])).toEqual([]);
  });
});

describe("applyBaseline", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-apply-baseline-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("diffs against a baseline that is there, and does nothing without one", () => {
    const present = join(dir, "prev.json");
    writeFileSync(present, JSON.stringify(report()));
    const r = report({ warnings: [] });
    expect(applyBaseline(r, present, "fail")).toBeUndefined();
    expect([r.diff?.baselinePath, r.warnings]).toEqual([present, []]);
    const none = report({ warnings: [] });
    expect(applyBaseline(none, undefined, "fail")).toBeUndefined();
    expect([none.diff, none.warnings]).toEqual([undefined, []]);
  });

  it("warns on a missing one, or says refuse under fail", () => {
    const missing = join(dir, "nope.json");
    const r = report();
    expect(applyBaseline(r, missing)).toBeUndefined();
    expect(r.warnings?.map((w) => [w.code, w.source])).toEqual([["baseline-missing", missing]]);
    expect(applyBaseline(report(), missing, "fail")).toBe("refuse");
  });

  // `--baseline "$PREV"` with PREV unset skipped the diff without a word, so
  // --baseline-strict and --fail-on-warnings both passed a CI cache miss.
  it("counts a given but empty path as missing", () => {
    const r = report({ warnings: [] });
    expect(applyBaseline(r, "")).toBeUndefined();
    expect(r.warnings).toEqual([
      {
        code: "baseline-missing",
        message: expect.stringMatching(/^baseline "" \(an empty path\) not found, so no diff was made/),
        source: "",
        count: 1,
      },
    ]);
    expect(applyBaseline(report(), "  ", "fail")).toBe("refuse");
  });
});

describe("faultRunWarnings", () => {
  it("says what unfiredFaults says, on every layer, with a code per diagnosis", () => {
    const r = report({
      faultInjections: [
        { rule: "net", matched: 0, injected: 0 },
        { rule: "declined", matched: 3, injected: 0, suppressed: 1 },
      ],
      runtimeFaults: [{ rule: "rt", matched: 0, fired: 0 }],
      lifecycleFaults: [{ name: "lc", matched: 2, fired: 0, errored: 2 }],
      iframeFaults: [
        { rule: "if", selector: "iframe", action: "never-load", matched: 0, fired: 0 } as never,
        // No counters: a hand-built row, or one an older version wrote.
        { rule: "bare", selector: "iframe", action: "never-load" } as never,
      ],
    });
    const warnings = faultRunWarnings(r);
    expect(warnings.map((w) => w.message)).toEqual(unfiredFaults(r));
    expect(warnings.map((w) => [w.code, w.layer, w.rule])).toEqual([
      ["fault-unmatched", "network", "net"],
      ["fault-unfired", "network", "declined"],
      ["fault-unmatched", "runtime", "rt"],
      ["fault-unfired", "lifecycle", "lc"],
      ["fault-unmatched", "iframe", "if"],
      ["fault-uncounted", "iframe", "bare"],
    ]);
    // A lifecycle fault that threw was not declined by its policy.
    expect(warnings[3]?.message).toBe('lifecycle fault "lc" matched 2x and never fired — it threw 2 time(s) (its lifecycle-fault-failed warnings say why)');
    expect(warnings[1]?.message).toContain("the firing policy said no; 1 decision(s) lost to a rule ahead of it");
  });

  it("tells a rule aimed at WebSocket traffic that no network fault sees it", () => {
    const r = report({
      faultInjections: [
        { rule: "ws-path", matched: 0, injected: 0, webSocket: { connections: 2, first: "ws://x/ws", webSocketOnly: false } },
        { rule: "ws-scheme", matched: 0, injected: 0, webSocket: { connections: 0, webSocketOnly: true } },
      ],
    });
    const [path, scheme] = faultRunWarnings(r);
    expect(path).toMatchObject({ code: "fault-websocket", rule: "ws-path", layer: "network" });
    expect(path?.message).toBe(
      'network fault "ws-path" never matched anything, and the run\'s pages opened 2 WebSocket connection(s) its pattern ' +
        "matches (first: ws://x/ws): network faults route HTTP requests, and Playwright's routes do not see WebSocket " +
        "traffic, so no network fault reaches it",
    );
    expect(scheme?.message).toContain("its pattern names only ws: / wss: URLs");
    expect(unfiredFaults(r)).toEqual([path?.message, scheme?.message]);
    // The logger event keeps its name, with the reach attached.
    expect(faultWarnings(r)[0]).toEqual({
      event: "fault_rule_unmatched",
      data: { rule: "ws-path", layer: "network", matched: 0, webSocket: { connections: 2, first: "ws://x/ws", webSocketOnly: false } },
    });
  });
});

describe("isWebSocketOnlyPattern", () => {
  it.each([
    [/^wss?:\/\//, true],
    [new RegExp("ws://localhost:3000/socket"), true],
    [/wss:\/\/api\.example\.com/, true],
    [/^(ws|http)s?:\/\//, false],
    [/\/ws$/, false],
    [/\/news:latest/, false],
    [/127\.0\.0\.1/, false],
  ])("%s → %s", (pattern, expected) => {
    expect(isWebSocketOnlyPattern(pattern)).toBe(expected);
  });
});

describe("the verdict and the outputs", () => {
  const withWarnings = report({
    warnings: [sitemap, { code: "driver-threw", message: 'driver "d" threw in selectAction (boom), so the step was skipped', count: 3 }],
  });

  it("passes with warnings, and fails on them under --fail-on-warnings, naming the first", () => {
    expect(getExitCode(withWarnings)).toBe(0);
    expect(getExitCode(withWarnings, { strict: true })).toBe(0);
    expect(exitReasons(withWarnings, { warnings: true })).toEqual([`--fail-on-warnings: 2 warnings (first: ${sitemap.message})`]);
    expect(exitReasons(report({ warnings: [sitemap] }), { warnings: true })).toEqual([`--fail-on-warnings: 1 warning (first: ${sitemap.message})`]);
    // Nothing to fail on: a report an older version wrote has no list.
    expect(getExitCode(report(), { warnings: true })).toBe(0);
  });

  it("puts a Warnings line in the compact and --quiet output, after the dead links, before Failed", () => {
    const line = `  Warnings: 2 (first: ${sitemap.message})`;
    expect(formatQuietReport(withWarnings).split("\n")).toEqual([expect.stringMatching(/^\[PASS\] /), line]);
    expect(formatCompactReport(withWarnings).split("\n")).toEqual([expect.stringMatching(/^\[PASS\] /), line]);
    const dead = report({
      ...withWarnings,
      summary: {
        ...summary(),
        discovery: { extractedLinks: 0, clickedLinks: 0, uniquePages: 1, deadLinks: [{ url: "http://x/gone", statusCode: 404, sourceUrl: "http://x/", method: "extracted" }], spaIssues: [] },
      },
    });
    expect(formatQuietReport(dead, { warnings: true }).split("\n")).toEqual([
      expect.stringMatching(/^\[FAIL\] /),
      "  Dead links: 1 (first: http://x/gone <- http://x/)",
      line,
      `  Failed: --fail-on-warnings: 2 warnings (first: ${sitemap.message})`,
    ]);
    expect(formatQuietReport(report())).not.toContain("Warnings");
  });

  it("ends the full report with a WARNINGS section", () => {
    const text = formatReport(withWarnings);
    const lines = text.split("\n");
    const at = lines.indexOf("WARNINGS (the run tested less than it was set up to)");
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at + 2, at + 4)).toEqual([
      `  [sitemap-unreadable] ${sitemap.message}`,
      '  [driver-threw] driver "d" threw in selectAction (boom), so the step was skipped (×3)',
    ]);
    expect(formatReport(report())).not.toContain("WARNINGS");
  });

  it("annotates each as ::warning, as ::error only under --fail-on-warnings", () => {
    const levels = (opts = {}) =>
      buildGithubAnnotations(withWarnings, opts).map((a) => [a.level, a.title, a.message]);
    expect(levels()).toEqual([
      ["warning", "chaosbringer warning: sitemap-unreadable", sitemap.message],
      ["warning", "chaosbringer warning: driver-threw", 'driver "d" threw in selectAction (boom), so the step was skipped (×3)'],
    ]);
    expect(levels({ warnings: true }).map(([level]) => level)).toEqual(["error", "error"]);
  });
});

describe("mergeReports' warnings", () => {
  it("diagnoses the faults again from the summed stats, and folds the rest", () => {
    // Shard 0 never saw a request the rule matches; shard 1 fired it.
    const a = report({
      faultInjections: [{ rule: "api", matched: 0, injected: 0 }, { rule: "dead", matched: 0, injected: 0 }],
      runtimeFaults: [{ rule: "rt", matched: 1, fired: 0 }],
      warnings: [
        { code: "fault-unmatched", message: "api never matched", count: 1, rule: "api", layer: "network" },
        { ...sitemap },
      ],
    });
    const b = report({
      pages: [{ url: "http://x/b", status: "success", loadTime: 1, errors: [], warnings: [], links: [] }],
      faultInjections: [{ rule: "api", matched: 2, injected: 2 }, { rule: "dead", matched: 0, injected: 0 }],
      runtimeFaults: [{ rule: "rt", matched: 1, fired: 1 }],
      warnings: [{ ...sitemap }],
    });
    a.iframeFaults = [{ rule: "if", selector: "iframe", action: "never-load", matched: 1, fired: 1, suppressed: 1 } as never];
    b.iframeFaults = [{ rule: "if", selector: "iframe", action: "never-load", matched: 2, fired: 1, suppressed: 2 } as never];
    const merged = mergeReports([a, b]);
    expect(merged.runtimeFaults).toEqual([{ rule: "rt", matched: 2, fired: 1 }]);
    // Every shard's `suppressed`, not the first one's.
    expect(merged.iframeFaults?.map((f) => [f.matched, f.fired, f.suppressed])).toEqual([[3, 2, 3]]);
    expect(merged.warnings).toEqual([
      { ...sitemap, count: 2 },
      {
        code: "fault-unmatched",
        message: unfiredFaults({ faultInjections: [{ rule: "dead", matched: 0, injected: 0 }] })[0],
        count: 1,
        rule: "dead",
        layer: "network",
      },
    ]);
  });

  it("keeps server-faults-unseen only when no shard saw a header", () => {
    const unseen: RunWarning = { code: "server-faults-unseen", message: "s", count: 1, layer: "server" };
    expect(mergeReports([report({ warnings: [unseen] }), report({ warnings: [] })]).warnings).toEqual([]);
    expect(mergeReports([report({ warnings: [unseen] }), report({ warnings: [unseen] })]).warnings).toEqual([{ ...unseen, count: 2 }]);
  });

  it("leaves the field out for reports an older version wrote", () => {
    expect(mergeReports([report(), report()]).warnings).toBeUndefined();
  });
});

describe("Driver.stats", () => {
  const step = (url: string) => ({ url }) as DriverStep;

  it("flowDriver says how far it got, which step it waits for, and where it stopped", async () => {
    const flow = flowDriver({
      name: "checkout",
      steps: [
        { name: "cart", urlPattern: "/cart", run: async () => {} },
        { name: "pay", urlPattern: "/pay", run: async () => { throw new Error("card declined"); } },
      ],
    });
    expect(flow.stats?.()).toEqual([{ driver: "checkout", completed: 0, total: 2, laps: 0, next: "cart" }]);
    const pick = await flow.selectAction(step("http://x/cart"));
    if (pick?.kind !== "custom") throw new Error("expected a custom pick");
    await pick.perform({} as never);
    expect(flow.stats?.()).toEqual([{ driver: "checkout", completed: 1, total: 2, laps: 0, next: "pay" }]);
    const pay = await flow.selectAction(step("http://x/pay"));
    if (pay?.kind !== "custom") throw new Error("expected a custom pick");
    await pay.perform({} as never);
    expect(flow.stats?.()).toEqual([
      { driver: "checkout", completed: 1, total: 2, laps: 0, halted: { step: "pay", error: "card declined" } },
    ]);
  });

  it("counts a finished pass, and the combinators forward their children's", async () => {
    const flow = flowDriver({ name: "one", steps: [{ name: "only", run: async () => {} }] });
    const pick = await flow.selectAction(step("http://x/"));
    if (pick?.kind !== "custom") throw new Error("expected a custom pick");
    await pick.perform({} as never);
    const done = [{ driver: "one", completed: 1, total: 1, laps: 1 }];
    expect(flow.stats?.()).toEqual(done);
    expect(compositeDriver([flow, samplingDriver({ driver: flow })]).stats?.()).toEqual([...done, ...done]);
  });
});
