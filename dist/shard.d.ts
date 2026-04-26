import type { CrawlReport } from "./types.js";
/**
 * FNV-1a 32-bit hash. Fast, stable, non-cryptographic. Used only for shard
 * partitioning — the only guarantees we rely on are determinism and a roughly
 * uniform distribution over the URL space.
 */
export declare function fnv1a(str: string): number;
/**
 * True when this shard owns `url`. Single-shard configs (count<=1) own
 * everything; otherwise ownership is `hash(url) % count === index`.
 */
export declare function shardOwns(url: string, shardIndex: number, shardCount: number): boolean;
/**
 * Merge N shard reports into one. Pages are deduplicated by URL (first-seen
 * wins), actions concatenated, error clusters re-merged by stable key with
 * counts summed and url/invariantName sets unioned. Scalars (duration,
 * blockedExternalNavigations, recoveryCount) fold as makes physical sense:
 * counts sum, duration is max-end minus min-start (wall-clock).
 */
export declare function mergeReports(reports: readonly CrawlReport[]): CrawlReport;
/**
 * Parse `--shard i/N` (or the pair --shard-index / --shard-count) into
 * { shardIndex, shardCount }. Throws with a named message on bad input.
 */
export declare function parseShardArg(value: string): {
    shardIndex: number;
    shardCount: number;
};
/** Entry point for the `shard` subcommand. Wired from src/cli.ts. */
export declare function runShardCli(argv: string[]): Promise<void>;
//# sourceMappingURL=shard.d.ts.map