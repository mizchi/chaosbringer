/**
 * Cache-stampede drill.
 *
 * The classic "front-line cache lost; backend can't absorb the
 * unbuffered traffic" pattern. Many published incidents involve some
 * version of this — the 2017 GitHub Memcached fail, the 2019 Slack
 * cache cluster fail, multiple AWS DDB hot-partition events that
 * started with a cache miss.
 *
 * Modeling: the target's customer path reads a tier-config row from
 * DDB on every request (the realistic anti-pattern in our fragile
 * baseline — no local cache). When DDB throttles this hot-key with
 * feedback (more requests → more throttle), the only sustainable
 * mitigation is to ADD a local cache that absorbs the read traffic.
 *
 * What separates this from the simple "DDB throttle" drill:
 *   - The chaos targets a SPECIFIC action (\`GetItem\` on tier-config),
 *     not all DDB. So agents who add a cache for tier-config but
 *     leave the order writes unchanged still recover.
 *   - The feedback parameters are tighter — small bursts above the
 *     threshold trigger the spiral fast.
 *   - The "right" mitigation is to ADD code (a cache), not to remove
 *     code (the eval-6 / WAL pattern). Tests a different shape.
 */
import type { Drill } from "../orchestrator.ts";

export interface CacheStampedeOptions {
  probeUrl: string;
  durationMs?: number;
}

export function cacheStampede(opts: CacheStampedeOptions): Drill {
  return {
    id: "cache-stampede",
    name: "DDB hot-key stampede (missing tier-config cache)",
    description:
      "Throttle DDB GetItem on the tier-config hot key, with load feedback. Mitigation requires adding a local cache.",
    peakPhaseIndex: 0,
    phases: [
      {
        label: "hot-key-saturated",
        durationMs: 90_000,
        rules: [
          {
            id: "ddb-tier-hot-key",
            enabled: true,
            match: { service: "dynamodb", action: "GetItem" },
            inject: {
              kind: "throttle",
              probability: 0.7,
              awsError: { code: "ProvisionedThroughputExceededException" },
              feedback: {
                windowMs: 1000,
                threshold: 10,
                probabilityStep: 0.01,
                maxProbability: 0.99,
              },
            },
          },
        ],
      },
    ],
    healthCheck: () => probe(opts.probeUrl),
    acceptance: { errorRate: 0.05, consecutiveGreen: 5 },
    brief: AI_BRIEF,
  };
}

async function probe(url: string): Promise<import("../orchestrator.ts").HealthCheckResult> {
  const t0 = performance.now();
  let ok = false;
  let detail: Record<string, unknown> | undefined;
  try {
    const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(5_000) });
    ok = res.ok;
    detail = { status: res.status };
  } catch (err) {
    detail = { error: String(err) };
  }
  return { ok, latencyMs: performance.now() - t0, errorRate: ok ? 0 : 1, detail };
}

const AI_BRIEF = `# Incident: DDB hot-key throttle on tier-config lookup

Every customer request fetches the same tier-config row from DDB.
There is NO cache. Under modest load that's already wasteful;
under throttle chaos the per-request misses pile up and feedback
amplifies the throttle.

What good agents do:
  - Look at chaos stats: rule targets dynamodb:GetItem specifically
    (not all DDB)
  - Look at target source: every order reads tier-config from DDB
  - Add a local in-memory cache (TTL'd or just process-lifetime)
    to absorb the read traffic
  - This is one of the few scenarios where ADDING code is the
    correct mitigation, not removing it

What bad agents do:
  - Add retries on GetItem (worsens feedback)
  - Cap retries (helps but doesn't fix the root cause)
  - Decouple the audit / receipt path (irrelevant — it's the read,
    not the writes)
`;
