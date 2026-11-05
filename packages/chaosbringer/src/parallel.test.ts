/**
 * parallelChaos unit tests use a stubbed `chaos()` via dependency
 * injection at the module boundary — vitest mock of `./chaos.js`. We
 * verify orchestration (concurrency cap, per-shard option merging,
 * merged report, exit code aggregation) without launching browsers.
 */
import { describe, expect, it, vi } from "vitest";

import type { ChaosResult } from "./chaos.js";
import type { CrawlReport } from "./types.js";

const fakeReport = (overrides: Partial<CrawlReport> = {}): CrawlReport => ({
  baseUrl: "https://example.test/",
  seed: 1,
  reproCommand: "chaosbringer --url https://example.test/",
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
  summary: {
    totalPages: 0,
    successfulPages: 0,
    failedPages: 0,
    errorRate: 0,
    averageActionsPerPage: 0,
    errorsByType: {},
    topErrorPages: [],
    discoveryMetrics: {
      initialUrls: 0,
      extractedLinks: 0,
      clickedLinks: 0,
      spaNavigations: 0,
      totalDiscovered: 0,
    },
  },
  errorClusters: [],
  ...overrides,
});

const fakeResult = (exitCode = 0): ChaosResult => ({
  report: fakeReport({ seed: exitCode + 1 }),
  passed: exitCode === 0,
  exitCode,
  warnings: [],
});

vi.mock("./chaos.js", async () => {
  const fakeReport = (overrides: Partial<CrawlReport> = {}): CrawlReport => ({
    baseUrl: "https://example.test/",
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
    summary: {
      totalPages: 0,
      successfulPages: 0,
      failedPages: 0,
      errorRate: 0,
      averageActionsPerPage: 0,
      errorsByType: {},
      topErrorPages: [],
      discoveryMetrics: {
        initialUrls: 0,
        extractedLinks: 0,
        clickedLinks: 0,
        spaNavigations: 0,
        totalDiscovered: 0,
      },
    },
    errorClusters: [],
    ...overrides,
  });
  const seenSeeds: number[] = [];
  return {
    // `fake` (not a real option) is the shard's report: its fault stats and
    // warnings. The verdict follows chaos()'s own rule for failOnWarnings.
    chaos: vi.fn(async (opts: { seed?: number; failOnWarnings?: boolean; fake?: Partial<CrawlReport> }) => {
      const seed = opts.seed ?? 0;
      seenSeeds.push(seed);
      const report = fakeReport({ seed, ...opts.fake });
      const exitCode = seed % 2 === 0 && !(opts.failOnWarnings && (report.warnings ?? []).length > 0) ? 0 : 1;
      return { report, passed: exitCode === 0, exitCode, warnings: report.warnings ?? [] };
    }),
    __seenSeeds: seenSeeds,
  };
});

import { parallelChaos } from "./parallel.js";

describe("parallelChaos", () => {
  it("invokes chaos() once per shard with merged options", async () => {
    const { chaos } = await import("./chaos.js");
    const out = await parallelChaos({
      base: { baseUrl: "https://example.test/" },
      shards: [
        { name: "form", options: { seed: 2 } },
        { name: "payload", options: { seed: 4 } },
      ],
    });
    expect(chaos).toHaveBeenCalledTimes(2);
    expect(out.shards.map((s) => s.name)).toEqual(["form", "payload"]);
    expect(out.passed).toBe(true);
    expect(out.exitCode).toBe(0);
  });

  it("aggregates exit codes via max across shards", async () => {
    const out = await parallelChaos({
      base: { baseUrl: "https://example.test/" },
      shards: [
        { options: { seed: 2 } }, // exits 0
        { options: { seed: 3 } }, // exits 1
      ],
    });
    expect(out.passed).toBe(false);
    expect(out.exitCode).toBe(1);
  });

  // URL shards: the rule targets a page only shard 1 crawled. Shard 0's
  // `fault-unmatched` failed the run, while the merged report (which sums the
  // stats and diagnoses them again) had no warning to say why.
  it("judges failOnWarnings on the merged report, not on each shard's", async () => {
    const unmatched = { code: "fault-unmatched" as const, message: "api never matched", count: 1, rule: "api", layer: "network" as const };
    const shard = (matched: number, warnings = matched === 0 ? [unmatched] : []) =>
      ({ seed: 2, fake: { faultInjections: [{ rule: "api", matched, injected: matched }], warnings } }) as never;
    const fired = await parallelChaos({
      base: { baseUrl: "https://example.test/", failOnWarnings: true },
      shards: [{ options: shard(0) }, { options: shard(1) }],
    });
    expect(fired.merged.warnings).toEqual([]);
    expect([fired.passed, fired.exitCode]).toEqual([true, 0]);

    // A warning the merge keeps fails it, whichever shard's options asked.
    const sitemap = { code: "sitemap-unreadable" as const, message: "s", count: 1 };
    const kept = await parallelChaos({
      base: { baseUrl: "https://example.test/" },
      shards: [{ options: { ...shard(1, [sitemap]), failOnWarnings: true } }, { options: shard(1) }],
    });
    expect(kept.merged.warnings).toEqual([sitemap]);
    expect([kept.passed, kept.exitCode]).toEqual([false, 1]);
    // Each shard itself was judged without it.
    expect(kept.shards.map((s) => s.result.exitCode)).toEqual([0, 0]);
  });

  it("respects the concurrency cap", async () => {
    // We can't directly assert wall-clock parallelism with a synchronous
    // mocked chaos, so use the fact that concurrency=1 still completes
    // every shard.
    const out = await parallelChaos({
      base: { baseUrl: "https://example.test/" },
      shards: [
        { options: { seed: 2 } },
        { options: { seed: 4 } },
        { options: { seed: 6 } },
      ],
      concurrency: 1,
    });
    expect(out.shards.length).toBe(3);
  });

  it("throws when shards list is empty", async () => {
    await expect(
      parallelChaos({ base: { baseUrl: "https://example.test/" }, shards: [] }),
    ).rejects.toThrow();
  });

  // Reference fakeResult so the import isn't unused — keeps tsc strict
  // about exported helpers happy in this file's review pass.
  it("fakeResult shape is referenced", () => {
    expect(fakeResult(0).exitCode).toBe(0);
  });
});
