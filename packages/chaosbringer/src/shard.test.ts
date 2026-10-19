import { describe, expect, it } from "vitest";
import { fakeSpan } from "./perf-fixtures.test-helpers.js";
import { UsageError } from "./cli-usage.js";
import {
  checkWorkerArgs,
  fnv1a,
  mergeReports,
  mergeWorkerPaths,
  parseShardArg,
  parseShardCliArgs,
  shardOwns,
  shardReproCommand,
} from "./shard.js";
import type { CrawlReport, CrawlSummary, PageError, PageResult } from "./types.js";

function summary(overrides: Partial<CrawlSummary> = {}): CrawlSummary {
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

function page(url: string, errors: PageError[] = [], extras: Partial<PageResult> = {}): PageResult {
  return {
    url,
    status: errors.length > 0 ? "error" : "success",
    loadTime: 100,
    errors,
    hasErrors: errors.length > 0,
    warnings: [],
    links: [],
    ...extras,
  };
}

function report(overrides: Partial<CrawlReport> = {}): CrawlReport {
  return {
    baseUrl: "http://localhost:3000",
    seed: 42,
    reproCommand: "chaosbringer --url http://localhost:3000",
    startTime: 0,
    endTime: 1000,
    duration: 1000,
    pagesVisited: 0,
    totalErrors: 0,
    totalWarnings: 0,
    blockedExternalNavigations: 0,
    recoveryCount: 0,
    pages: [],
    actions: [],
    summary: summary(),
    errorClusters: [],
    ...overrides,
  };
}

describe("fnv1a", () => {
  it("returns 0x811c9dc5 for empty string", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
  });

  it("is deterministic", () => {
    expect(fnv1a("http://example.com/a")).toBe(fnv1a("http://example.com/a"));
  });

  it("differs for different inputs", () => {
    expect(fnv1a("a")).not.toBe(fnv1a("b"));
  });

  it("always returns a uint32", () => {
    for (const s of ["", "a", "http://example.com/deep/nested/page?q=1"]) {
      const h = fnv1a(s);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(h)).toBe(true);
    }
  });
});

describe("shardOwns", () => {
  it("owns everything when shardCount <= 1", () => {
    expect(shardOwns("http://any/", 0, 1)).toBe(true);
    expect(shardOwns("http://other/", 0, 0)).toBe(true);
  });

  it("partitions urls by hash mod count", () => {
    const count = 4;
    const urls = [
      "http://example.com/a",
      "http://example.com/b",
      "http://example.com/c",
      "http://example.com/d",
      "http://example.com/e",
    ];
    for (const url of urls) {
      const ownedBy = [0, 1, 2, 3].filter((i) => shardOwns(url, i, count));
      expect(ownedBy).toHaveLength(1);
    }
  });

  it("gives each shard a roughly-proportional fraction over many urls", () => {
    const count = 4;
    const N = 200;
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < N; i++) {
      for (let s = 0; s < count; s++) {
        if (shardOwns(`http://example.com/page-${i}`, s, count)) counts[s]!++;
      }
    }
    for (const c of counts) {
      expect(c).toBeGreaterThan(N / count / 3);
    }
  });
});

describe("parseShardArg", () => {
  it("parses i/N format", () => {
    expect(parseShardArg("2/4")).toEqual({ shardIndex: 2, shardCount: 4 });
  });

  it("tolerates whitespace around the slash", () => {
    expect(parseShardArg("0 / 2")).toEqual({ shardIndex: 0, shardCount: 2 });
  });

  it("rejects non-numeric input", () => {
    expect(() => parseShardArg("a/b")).toThrow(/must be in the form/);
  });

  it("rejects an out-of-range index", () => {
    expect(() => parseShardArg("4/4")).toThrow(/out of range/);
  });

  it("rejects a zero count", () => {
    expect(() => parseShardArg("0/0")).toThrow(/count must be >= 1/);
  });
});

describe("mergeReports", () => {
  it("throws on empty input", () => {
    expect(() => mergeReports([])).toThrow(/at least one/);
  });

  it("returns a copy of a single report", () => {
    const r = report({ pages: [page("http://localhost:3000/")] });
    const merged = mergeReports([r]);
    expect(merged).not.toBe(r);
    expect(merged.pages).toHaveLength(1);
  });

  it("deduplicates pages across shards by URL", () => {
    const a = report({
      pages: [page("http://localhost:3000/"), page("http://localhost:3000/a")],
    });
    const b = report({
      pages: [page("http://localhost:3000/"), page("http://localhost:3000/b")],
    });
    const merged = mergeReports([a, b]);
    const urls = merged.pages.map((p) => p.url).sort();
    expect(urls).toEqual([
      "http://localhost:3000/",
      "http://localhost:3000/a",
      "http://localhost:3000/b",
    ]);
    expect(merged.pagesVisited).toBe(3);
  });

  it("sums blockedExternalNavigations and recoveryCount", () => {
    const a = report({ blockedExternalNavigations: 2, recoveryCount: 1 });
    const b = report({ blockedExternalNavigations: 3, recoveryCount: 4 });
    const merged = mergeReports([a, b]);
    expect(merged.blockedExternalNavigations).toBe(5);
    expect(merged.recoveryCount).toBe(5);
  });

  it("uses wall-clock duration (max end - min start)", () => {
    const a = report({ startTime: 100, endTime: 500, duration: 400 });
    const b = report({ startTime: 300, endTime: 900, duration: 600 });
    const merged = mergeReports([a, b]);
    expect(merged.startTime).toBe(100);
    expect(merged.endTime).toBe(900);
    expect(merged.duration).toBe(800);
  });

  it("recomputes clusters from merged page errors", () => {
    const err = (url: string, msg: string): PageError => ({
      type: "console",
      message: msg,
      url,
      timestamp: 0,
    });
    const a = report({
      pages: [
        page("http://localhost:3000/a", [err("http://localhost:3000/a", "boom")]),
      ],
    });
    const b = report({
      pages: [
        page("http://localhost:3000/b", [
          err("http://localhost:3000/b", "boom"),
          err("http://localhost:3000/b", "boom"),
        ]),
      ],
    });
    const merged = mergeReports([a, b]);
    const c = merged.errorClusters.find((x) => x.fingerprint.includes("boom"));
    expect(c).toBeDefined();
    expect(c!.count).toBe(3);
    expect(c!.urls.sort()).toEqual([
      "http://localhost:3000/a",
      "http://localhost:3000/b",
    ]);
  });

  it("drops phantom clusters when a duplicate page is deduplicated", () => {
    // baseUrl appears in both shards (typical when both seed from baseUrl).
    // If only one copy survives, the surviving errors must drive clustering
    // — clusters from the dropped copy cannot reappear in the output.
    const err = (msg: string): PageError => ({
      type: "console",
      message: msg,
      url: "http://localhost:3000/",
      timestamp: 0,
    });
    const first = page("http://localhost:3000/", [err("kept")]);
    const duplicate = page("http://localhost:3000/", [err("dropped")]);
    const a = report({ pages: [first] });
    const b = report({ pages: [duplicate] });
    const merged = mergeReports([a, b]);
    const fingerprints = merged.errorClusters.map((c) => c.fingerprint);
    expect(fingerprints).toContain("kept");
    expect(fingerprints).not.toContain("dropped");
  });

  it("recomputes totalErrors from merged pages", () => {
    const err: PageError = { type: "console", message: "x", timestamp: 0 };
    const a = report({
      pages: [page("http://localhost:3000/a", [err, err])],
    });
    const b = report({
      pages: [page("http://localhost:3000/b", [err])],
    });
    const merged = mergeReports([a, b]);
    expect(merged.totalErrors).toBe(3);
  });

  it("merges fault-injection stats by rule name", () => {
    const a = report({
      faultInjections: [{ rule: "r1", matched: 5, injected: 2 }],
    });
    const b = report({
      faultInjections: [{ rule: "r1", matched: 3, injected: 1 }, { rule: "r2", matched: 4, injected: 4 }],
    });
    const merged = mergeReports([a, b]);
    const r1 = merged.faultInjections!.find((f) => f.rule === "r1");
    expect(r1).toEqual({ rule: "r1", matched: 8, injected: 3 });
    expect(merged.faultInjections).toHaveLength(2);
  });

  it("keeps the settle mode the shards agree on, and drops one they disagree on (B5)", () => {
    const measured = (url: string, settle: NonNullable<CrawlReport["perf"]>["settle"]) =>
      report({
        pages: [page(url, [], { perf: fakeSpan(`${new URL(url).pathname} :: load`) })],
        perf: { settle, vitals: {}, slowestActions: [], hotInitiators: [], thirdParty: [], totals: { spans: 1, pages: 1 } },
      });
    const idle = { mode: "networkidle" } as const;
    expect(mergeReports([measured("http://x/a", idle), measured("http://x/b", idle)]).perf?.settle).toEqual(idle);
    // Spans of two modes in one report: claiming either would let perf regress compare it as that mode.
    const mixed = mergeReports([measured("http://x/a", idle), measured("http://x/b", { mode: "adaptive", quietMs: 100 })]);
    expect(mixed.perf).toBeDefined();
    expect(mixed.perf!.settle).toBeUndefined();
  });
});

describe("shard CLI", () => {
  const args = (argv: string[]) => {
    const parsed = parseShardCliArgs(argv);
    if (!parsed) throw new Error("parsed as --help");
    return parsed;
  };

  it("refuses an unknown flag before a worker starts, by the main crawl's option table", async () => {
    // Forwarded, it failed in each of the N workers and ended in
    // `could not read …/shard-0.json` and exit 1.
    await expect(checkWorkerArgs(args(["--count", "2", "--url", "http://x.test/", "--bogus"]))).rejects.toMatchObject({
      code: "ERR_PARSE_ARGS_UNKNOWN_OPTION",
    });
    await expect(checkWorkerArgs(args(["--count", "2", "--url", "http://x.test/", "--max-pages", "0"]))).rejects.toMatchObject({
      name: "UsageError",
      message: "--max-pages must be >= 1 (got 0)",
    });
    await expect(checkWorkerArgs(args(["--count", "2"]))).rejects.toMatchObject({ message: "--url is required" });
    expect(() => args(["--url", "http://x.test/"])).toThrow(UsageError);
  });

  it("gives every worker the seed given, or one drawn for the run", async () => {
    expect((await checkWorkerArgs(args(["--count", "2", "--url", "http://x.test/", "--seed", "42"]))).seed).toBe(42);
    expect(Number.isInteger((await checkWorkerArgs(args(["--count", "2", "--url", "http://x.test/"]))).seed)).toBe(true);
  });

  it("names the files the coordinator writes again from the merged report", async () => {
    const run = (extra: string[]) => checkWorkerArgs(args(["--count", "2", "--url", "http://x.test/", ...extra]));
    expect((await run([])).files).toEqual({});
    expect(
      (await run(["--junit", "j.xml", "--heatmap-out", "h.json", "--failure-artifacts", "fa", "--cluster-artifacts", "--cluster-min-count", "2"]))
        .files,
    ).toEqual({ junit: "j.xml", heatmapOut: "h.json", clusterBundles: { bundleDir: "fa", minCount: 2 } });
  });

  it("reruns the whole sharded run from the merged Repro line", () => {
    expect(shardReproCommand("chaosbringer --url http://x.test/ --seed 7 --max-pages 3 --shard 1/4 --strict", 4)).toBe(
      "chaosbringer shard --count 4 --url http://x.test/ --seed 7 --max-pages 3 --strict",
    );
    expect(shardReproCommand("chaosbringer --url http://x.test/ --seed 7 --shard 0/2", 2)).toBe(
      "chaosbringer shard --count 2 --url http://x.test/ --seed 7",
    );
  });

  // `shard --quiet` silences the workers, whose lines were the only ones to
  // name the bundles, trace and log they wrote.
  it("merges the paths the silenced workers wrote, in the main command's order", () => {
    const worker0 = [
      "[PASS] 2 pages, 0 errors, 1.0s (seed=7)",
      "Log saved to: run.log",
      "Wrote 0 cluster bundle(s) to out/clusters/",
      "Report saved to: /tmp/chaos-shard-x/shard-0.json",
      "JUnit XML saved to: junit.xml",
    ].join("\n");
    const worker1 = [
      "[FAIL] 2 pages, 3 errors, 1.0s (seed=7)",
      "  Failed: --strict: 1 unhandled rejection",
      "",
      "Heatmap saved to: heat.json",
      "Wrote 2 failure bundle(s) to out/",
      "Trace saved to: run.trace.jsonl",
      "Log saved to: run.log",
      "Wrote 1 cluster bundle(s) to out/clusters/",
      "Report saved to: /tmp/chaos-shard-x/shard-1.json",
      "JUnit XML saved to: junit.xml",
    ].join("\n");
    // The heatmap, the cluster bundles and the JUnit file are the coordinator's,
    // written again from the merged report.
    expect(mergeWorkerPaths([worker0, worker1, "Wrote 1 failure bundle(s) to out/\n"])).toEqual([
      "Wrote 3 failure bundle(s) to out/",
      "Trace saved to: run.trace.jsonl",
      "Log saved to: run.log",
    ]);
    expect(mergeWorkerPaths(["[PASS] 1 pages, 0 errors\nReport saved to: /tmp/x.json\n"])).toEqual([]);
  });
});
