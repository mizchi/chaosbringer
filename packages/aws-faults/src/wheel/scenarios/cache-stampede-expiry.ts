/**
 * Scenario: cache stampede on TTL expiry (thundering herd).
 *
 * Different from tier-lookup-stampede (which is "ADD a cache" — no
 * cache present). Here a cache EXISTS with a TTL, but every TTL
 * boundary triggers a herd of concurrent misses that all hit DDB,
 * because no singleflight / coalesce pattern is in place. Under
 * upstream latency the stampede is observable as periodic p99
 * spikes that line up with TTL boundaries.
 *
 * Correct mitigations:
 *   1. Singleflight — share one in-flight Promise per cache key
 *      across concurrent misses.
 *   2. Probabilistic early refresh (XFetch).
 *   3. Stale-while-revalidate: serve cached value past hard TTL
 *      while refreshing async.
 */
import type { Scenario } from "../types.ts";
import {
  chaosRulesPreserved,
  checkedKumoChaosStats,
  customerImpactRecovered,
  didNotAddRetries,
  investigatedBeforeEditing,
  minimalCodeChange,
  readTargetSource,
  recoveredSlo,
  statedHypothesis,
} from "../scoring.ts";
import { llmJudged } from "../scoring-llm.ts";
import { baselineLatency } from "../../drills/baseline-latency.ts";

export interface CacheStampedeExpiryOptions {
  probeUrl: string;
  customerUrl?: string;
  durationMs?: number;
}

export function cacheStampedeExpiry(opts: CacheStampedeExpiryOptions): Scenario {
  return {
    id: "cache-stampede-expiry",
    chaosModelVersion: "fixed-v1",
    baselineFile: "server.cache-stampede.ts",
    title: "OrderService p99 spiking every ~5s; correlates with cache TTL",
    initialAlert:
      "[P1] OrderService: p99 spikes to 4-6s in clean 5-second cycles. p50 " +
      "is healthy. DDB GetItem on tier-config shows the same cyclic burst — " +
      "tens of concurrent calls every cycle, idle in between. kumo chaos " +
      "rule active: ddb-baseline-latency (p99=400ms). On-call paged.",
    drill: baselineLatency({ probeUrl: opts.probeUrl, p99Ms: 800 }),
    groundTruth:
      "Target has an in-process tier-config cache with TTL=5s and NO " +
      "singleflight. Every cache expiry, multiple concurrent /orders " +
      "calls all see a miss and all kick off independent GetItem calls " +
      "against tier-config. Under the active baseline-latency chaos " +
      "(p99=800ms), each miss takes ~800ms — during which more requests " +
      "arrive, all miss, all stampede. /__cache exposes the misses + " +
      "inflight counters; agents should see stampedeBursts climbing. " +
      "Correct mitigation: singleflight (dedupe concurrent misses by " +
      "key) OR probabilistic early refresh OR stale-while-revalidate. " +
      "Wrong directions: pool tuning (pool fine), disable cache " +
      "(hurts hit-path latency), bump TTL (delays the problem).",
    pages: [
      { atSec: 18, severity: "info", text: "Datadog: tier-config GetItem rate spikes every 5s, otherwise idle. Pattern matches cache TTL." },
      { atSec: 50, severity: "warn", text: "Customer support: 'orders are mostly fast but occasionally take 3-5 seconds.'" },
      { atSec: 95, severity: "info", text: "Platform colleague: 'curl localhost:3000/__cache repeatedly — if stampedeBursts is growing, you have concurrent misses on every TTL boundary.'" },
    ],
    redHerrings: [
      { hypothesis: "Disabled the cache entirely", matchKeyword: "(remove|disable|delete).*cache|cache.*disable" },
      { hypothesis: "Bumped pool size as if pool was the bottleneck", matchKeyword: "(pool\\.max|increase.*pool|raise.*pool)" },
      { hypothesis: "Just bumped TTL longer to hide the problem", matchKeyword: "TIER_TTL_MS\\s*=\\s*[1-9]\\d{4,}|TTL.*(longer|increase|bump)" },
    ],
    idealPath: [
      "Inspect /__cache — see stampedeBursts climbing every 5s",
      "Read target/src/server.cache-stampede.ts — find getTier() with no inflight dedupe",
      "Hypothesize: stampede on TTL expiry under upstream latency",
      "Mitigate: add singleflight (Map<key, Promise>) so concurrent misses share one call",
      "Verify /orders p99 < 1s sustained",
    ],
    rubric: [
      investigatedBeforeEditing(3),
      checkedKumoChaosStats(2),
      readTargetSource(4),
      statedHypothesis(2),
      didNotAddRetries(2),
      minimalCodeChange(3, 3),
      recoveredSlo(3),
      ...(opts.customerUrl ? [customerImpactRecovered({ customerUrl: opts.customerUrl, weight: 4 })] : []),
      chaosRulesPreserved(3),
      llmJudged({
        id: "added-singleflight",
        weight: 6,
        description: "Added singleflight / dedupe pattern for concurrent cache misses (not disable / not just longer TTL)",
        question: "Did the agent address the thundering-herd by adding a singleflight / inflight-dedupe pattern, probabilistic early refresh, or stale-while-revalidate? Answer NO if the agent disabled the cache, only tuned TTL, bumped pool, or added retries.",
        regexFallback: (ctx) => /(singleflight|inflight\s*dedup|stale[\s-]*while[\s-]*revalidate|XFetch|coalesce|in-flight.*Promise|Promise.*inflight|Map<.*Promise>)/i.test((ctx.journalContents ?? []).join("\n") + "\n" + (ctx.transcript ?? "")),
      }),
    ],
  };
}
