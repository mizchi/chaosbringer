/**
 * Pure latency aggregation. Workers record raw samples; aggregation
 * happens once at report-build time, so the hot path stays cheap (no
 * histogram per sample). We use sort-based quantiles — adequate for
 * up to ~100k samples which covers light-load runs (10 workers × few
 * mins × 30 req/iter).
 *
 * For heavier load tests we would swap this for hdrhistogram-js, but
 * the design here ("軽量負荷") keeps the lightest possible
 * implementation.
 */
import type { LatencyStats } from "./types.js";

export function emptyLatencyStats(): LatencyStats {
  return { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, minMs: 0, maxMs: 0 };
}

/**
 * Compute basic latency statistics. Samples are NOT mutated.
 * Returns zeroed stats for an empty input.
 */
export function latencyStats(samplesMs: ReadonlyArray<number>): LatencyStats {
  if (samplesMs.length === 0) return emptyLatencyStats();
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const n = sorted.length;
  let sum = 0;
  for (const s of sorted) sum += s;
  return {
    count: n,
    meanMs: sum / n,
    p50Ms: quantile(sorted, 0.5),
    p95Ms: quantile(sorted, 0.95),
    p99Ms: quantile(sorted, 0.99),
    minMs: sorted[0]!,
    maxMs: sorted[n - 1]!,
  };
}

/**
 * Linear-interpolated quantile on a pre-sorted ascending array.
 * Matches numpy's "linear" interpolation.
 */
export function quantile(sortedAsc: ReadonlyArray<number>, q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (q <= 0) return sortedAsc[0]!;
  if (q >= 1) return sortedAsc[sortedAsc.length - 1]!;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = pos - lo;
  return sortedAsc[lo]! * (1 - frac) + sortedAsc[hi]! * frac;
}

/** Parse `"5s"` / `"500ms"` / `"2m"` / number(ms) into a millisecond count. */
export function parseDurationMs(input: number | string): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) throw new Error(`parseDurationMs: invalid number ${input}`);
    return input;
  }
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/.exec(input.trim());
  if (!m) throw new Error(`parseDurationMs: cannot parse "${input}"`);
  const value = Number(m[1]);
  const unit = m[2] ?? "ms";
  switch (unit) {
    case "ms":
      return value;
    case "s":
      return value * 1000;
    case "m":
      return value * 60_000;
  }
  throw new Error(`parseDurationMs: unknown unit ${unit}`);
}
