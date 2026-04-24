import { describe, expect, it } from "vitest";
import type { ErrorCluster } from "./clusters.js";
import { fnv1a, mergeReports, parseShardArg, shardOwns } from "./shard.js";
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
  const cluster = (key: string, count: number, urls: string[] = []): ErrorCluster => ({
    key,
    type: "console",
    fingerprint: key.split("|")[1] ?? "",
    sample: { type: "console", message: "boom", timestamp: 0 },
    count,
    urls,
  });

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

  it("merges clusters by key, summing counts and unioning urls", () => {
    const a = report({
      errorClusters: [cluster("console|boom", 3, ["http://localhost:3000/a"])],
    });
    const b = report({
      errorClusters: [cluster("console|boom", 5, ["http://localhost:3000/b"])],
    });
    const merged = mergeReports([a, b]);
    const merged_cluster = merged.errorClusters.find((c) => c.key === "console|boom");
    expect(merged_cluster).toBeDefined();
    expect(merged_cluster!.urls.sort()).toEqual([
      "http://localhost:3000/a",
      "http://localhost:3000/b",
    ]);
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
});
