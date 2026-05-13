/**
 * Parallel chaos runner. Spawns N independent `chaos()` runs in
 * parallel, each with its own browser, RNG seed, and driver. Useful
 * for:
 *   - sharded crawls (same site, different URL shards — see `shard.ts`)
 *   - driver-bank exploration (one shard with `formDriver`, another
 *     with `payloadDriver`, another with `aiDriver`) where shards
 *     surface different bug classes in one wall-clock window.
 *
 * Each shard runs in isolation — separate browsers, separate RNGs,
 * separate driver instances. **There is intentionally no shared state
 * between shards**; budgets and stall trackers each belong to one
 * shard. This keeps the parallel layer trivially safe at the cost of
 * a small amount of redundant work (e.g. an AI budget cap of 10 runs
 * with `parallel: 3` yields up to 30 calls total — pre-divide if you
 * want strict caps).
 */
import { chaos, type ChaosResult, type ChaosRunOptions } from "./chaos.js";
import { mergeReports } from "./shard.js";
import type { CrawlerEvents, CrawlReport } from "./types.js";

export interface ParallelShardSpec {
  /** Human label that surfaces in the merged report's per-shard summary. */
  name?: string;
  /**
   * Per-shard overrides applied on top of the base `chaos()` options.
   * Common overrides: `seed`, `driver`, `shardIndex` + `shardCount`,
   * `excludePatterns`. Anything left unspecified inherits from base.
   */
  options: Partial<ChaosRunOptions>;
  events?: CrawlerEvents;
}

export interface ParallelChaosOptions {
  /** Base options shared by every shard (baseUrl, faults, invariants, …). */
  base: ChaosRunOptions;
  shards: ReadonlyArray<ParallelShardSpec>;
  /**
   * Maximum shards running at once. Default: shards.length (full fan-out).
   * Set lower when each shard launches a browser and CI memory is tight.
   */
  concurrency?: number;
}

export interface ParallelShardResult {
  name: string;
  result: ChaosResult;
}

export interface ParallelChaosResult {
  /** Per-shard results in the order shards were provided. */
  shards: ParallelShardResult[];
  /** Merged report — page errors, actions, fault stats joined across shards. */
  merged: CrawlReport;
  /** True iff every shard's `passed` is true. */
  passed: boolean;
  /** `max(exitCode)` across shards — non-zero if any shard failed. */
  exitCode: number;
}

/**
 * Run multiple chaos shards in parallel and merge their reports.
 *
 * Each shard is run via the public `chaos()` entry point so all of the
 * usual semantics (setup hook, baseline diff, exit-code rules) apply
 * per-shard. The merge step uses `mergeReports` so the final shape is
 * the same `CrawlReport` consumers already know — no special-casing
 * needed downstream.
 */
export async function parallelChaos(
  options: ParallelChaosOptions,
): Promise<ParallelChaosResult> {
  if (options.shards.length === 0) {
    throw new Error("parallelChaos: shards is empty");
  }
  const concurrency = Math.max(1, options.concurrency ?? options.shards.length);

  const namedShards = options.shards.map((s, i) => ({
    name: s.name ?? `shard-${i}`,
    spec: s,
    index: i,
  }));

  const results: ParallelShardResult[] = new Array(namedShards.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= namedShards.length) return;
      const { name, spec } = namedShards[idx]!;
      const merged: ChaosRunOptions = { ...options.base, ...spec.options };
      const result = await chaos(merged, spec.events ?? {});
      results[idx] = { name, result };
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, namedShards.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  const merged = mergeReports(results.map((r) => r.result.report));
  const exitCode = results.reduce((m, r) => Math.max(m, r.result.exitCode), 0);
  return {
    shards: results,
    merged,
    passed: exitCode === 0,
    exitCode,
  };
}
