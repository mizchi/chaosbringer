/**
 * Postgres pool fault injection (issue #119 Gap 1).
 *
 * Why a parallel chaos engine: kumo simulates AWS API surfaces over
 * HTTP. Real Postgres / RDS use the pg-wire protocol and a server-side
 * connection queue, neither of which kumo emulates. To get pool-
 * exhaustion / replica-lag / vacuum-lock scenarios we need fault
 * injection that lives between the app and a real `pg` Pool.
 *
 * Design:
 *   - `wrapPool(pool, config)` returns a Pool-shaped object where
 *     `.connect()` / `.query()` apply configured faults before
 *     delegating to the real Pool.
 *   - Config is JSON, loaded once at process startup (e.g. from
 *     `PG_CHAOS_CONFIG` env var). The agent cannot disable it from
 *     inside the running target — they have to mitigate at the app
 *     level (raise max, set query timeout, kill long queries, etc.),
 *     same constraint as kumo's chaos rules.
 *
 * Initial supported fault kind:
 *   - `pool-exhaustion`: with probability p, the wrapped client's
 *     `.query()` holds the connection for `holdMs` ms (default 60s)
 *     before releasing. Once the pool's `max` connections are all
 *     held, `connect()` queues forever (or hits the pool's idle/
 *     acquire timeout).
 *
 * Future kinds (out of scope for this slice):
 *   - `replica-lag` — `SELECT` after `INSERT` returns no rows for
 *     `lagMs`
 *   - `vacuum-lock` — extreme latency on `INSERT`/`UPDATE`, fine on
 *     reads
 *   - `slow-query` — uniform query latency
 */
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

export interface PoolExhaustionFault {
  kind: "pool-exhaustion";
  /** Probability of any single .query() call being a "stuck" one. */
  probability: number;
  /**
   * How long a "stuck" query holds the connection before releasing
   * (ms). Defaults to 60_000 — long enough that any reasonable test
   * exhausts a small pool.
   */
  holdMs?: number;
  /** Optional regex matched against the SQL text. Skips otherwise. */
  matchSql?: string;
}

export type PgChaosFault = PoolExhaustionFault;

export interface PgChaosConfig {
  faults: PgChaosFault[];
}

const DEFAULT_HOLD_MS = 60_000;

/**
 * Wrap a `pg` Pool so chaos rules apply to every connection / query
 * borrowed from it. The returned object exposes the subset of the
 * Pool API the rehearsal target uses; it is not a drop-in for every
 * pg consumer but enough for typical orders-style write paths.
 */
export function wrapPool(pool: Pool, config: PgChaosConfig): Pool {
  const stats = { stuckActive: 0, stuckTotal: 0, queries: 0 };

  function pickFault(sql: string): PoolExhaustionFault | null {
    for (const f of config.faults) {
      if (f.kind !== "pool-exhaustion") continue;
      if (f.matchSql && !new RegExp(f.matchSql, "i").test(sql)) continue;
      if (Math.random() < f.probability) return f;
    }
    return null;
  }

  // Wrap .query at the Pool level. The Pool's own .query implementation
  // borrows a client, runs the query, and releases — we intercept by
  // holding the borrowed client for `holdMs` when a fault fires.
  const originalQuery = pool.query.bind(pool);
  pool.query = (async function (
    this: Pool,
    text: string | { text: string; values?: unknown[] },
    valuesOrCb?: unknown,
    maybeCb?: unknown,
  ): Promise<QueryResult<QueryResultRow>> {
    stats.queries++;
    const sql = typeof text === "string" ? text : text.text;
    const fault = pickFault(sql);
    if (fault) {
      // Hold a client for holdMs before letting the real query proceed.
      // The client is released at the end — but by then many other
      // requests have queued on pool.connect().
      const hold = fault.holdMs ?? DEFAULT_HOLD_MS;
      stats.stuckActive++;
      stats.stuckTotal++;
      const client = await pool.connect();
      try {
        await new Promise((r) => setTimeout(r, hold));
        // Now actually run the user's query on the held client.
        const result = await client.query(
          text as string,
          valuesOrCb as unknown[] | undefined,
        );
        return result as QueryResult<QueryResultRow>;
      } finally {
        client.release();
        stats.stuckActive--;
      }
    }
    return originalQuery(text as string, valuesOrCb as unknown[] | undefined) as Promise<
      QueryResult<QueryResultRow>
    >;
  }) as Pool["query"];

  // Expose stats via a tag on the pool — the target can mount these on
  // a /pg-chaos/stats endpoint if desired (parallel to /kumo/chaos/stats).
  (pool as Pool & { __chaosStats?: typeof stats }).__chaosStats = stats;

  return pool;
}

/**
 * Convenience: parse a JSON config from an env var and return it,
 * or null when unset / malformed (in which case wrapPool should be
 * skipped so chaos is fully disabled).
 */
export function loadPgChaosConfig(envVar = "PG_CHAOS_CONFIG"): PgChaosConfig | null {
  const raw = process.env[envVar];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PgChaosConfig;
    if (!Array.isArray(parsed.faults)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Read pool chaos stats for the /pg-chaos/stats observability surface
 * the agent uses to confirm the chaos exists. Returns null if the
 * pool wasn't wrapped (i.e. no chaos).
 */
export function pgChaosStats(pool: Pool): { queries: number; stuckActive: number; stuckTotal: number } | null {
  const s = (pool as Pool & { __chaosStats?: { queries: number; stuckActive: number; stuckTotal: number } }).__chaosStats;
  return s ?? null;
}

/**
 * Helper PoolClient guard used by some target tests that need to
 * borrow a client outside the chaos path. Currently a no-op pass-
 * through; kept for symmetry with wrapPool and to give the target
 * a single import surface.
 */
export function unwrap(client: PoolClient): PoolClient {
  return client;
}
