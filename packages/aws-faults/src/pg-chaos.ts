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

/**
 * Simulates replica-lag: a SELECT against a primary key that was
 * INSERTed in the last `lagMs` returns 0 rows. Reproduces the
 * read-after-write inconsistency you get when reading from a lagging
 * read replica. Mitigation in real systems: prefer-primary for
 * reads-after-writes, INSERT ... RETURNING, or short waits with
 * retry.
 *
 * Implementation note: we track recently-inserted ids in a sliding
 * window per call to wrapPool. Detection of "is this SELECT for a
 * recently-INSERTed id" is heuristic — we look for `INSERT INTO X
 * ... ($id, ...)` and `SELECT ... WHERE id = $1` patterns. Custom
 * SQL shapes can pass `matchSql` to narrow scope.
 */
export interface ReplicaLagFault {
  kind: "replica-lag";
  /** Probability a matched SELECT trips the lag. */
  probability: number;
  /** How long an INSERTed row stays "invisible" to SELECT. Default 1500ms. */
  lagMs?: number;
}

/**
 * Adds uniform latency to matched queries. Models the vacuum-lock /
 * busy-table / missing-index patterns where SQL execution is just
 * slow without errors. Differs from pool-exhaustion: a slow query
 * doesn't necessarily hold its connection longer than its own
 * runtime, so the pool can still cycle as long as enough connections
 * exist. Differs from replica-lag: rows ARE returned, just slowly.
 *
 * Real-world analogs: a table mid-VACUUM, a query missing an index,
 * lock contention on a hot row. The mitigation vocabulary is
 * statement_timeout, query-killer sweeps, or fixing the offending
 * query path (add index, batch reads).
 */
export interface SlowQueryFault {
  kind: "slow-query";
  /** Probability a matched query trips the slowdown. */
  probability: number;
  /** Milliseconds to sleep before delegating to the real Pool. Default 2000. */
  latencyMs?: number;
  /**
   * Optional regex matched against SQL — set to e.g. "^\\s*UPDATE"
   * to only slow writes (the vacuum-lock pattern). Defaults to
   * matching everything.
   */
  matchSql?: string;
}

export type PgChaosFault = PoolExhaustionFault | ReplicaLagFault | SlowQueryFault;

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
  const stats = {
    stuckActive: 0,
    stuckTotal: 0,
    queries: 0,
    /** Number of SELECTs that were forced to return 0 rows by replica-lag. */
    lagHidden: 0,
    /** Number of queries that hit slow-query latency injection. */
    slowed: 0,
  };

  /**
   * Sliding window of recently-INSERTed primary-key values, with
   * their insert timestamps. Used by replica-lag detection to know
   * which ids should be "invisible" to immediate SELECTs.
   */
  const recentInserts = new Map<string, number>();
  function pruneRecentInserts(now: number) {
    // Bound the window to the largest configured lagMs so we don't
    // leak memory across long runs.
    const maxLag = config.faults
      .filter((f): f is ReplicaLagFault => f.kind === "replica-lag")
      .reduce((m, f) => Math.max(m, f.lagMs ?? 1500), 0);
    if (maxLag === 0) return;
    const cutoff = now - maxLag;
    for (const [k, t] of recentInserts) {
      if (t < cutoff) recentInserts.delete(k);
    }
  }

  function pickPoolExhaustionFault(sql: string): PoolExhaustionFault | null {
    for (const f of config.faults) {
      if (f.kind !== "pool-exhaustion") continue;
      if (f.matchSql && !new RegExp(f.matchSql, "i").test(sql)) continue;
      if (Math.random() < f.probability) return f;
    }
    return null;
  }

  function pickReplicaLagFault(): ReplicaLagFault | null {
    for (const f of config.faults) {
      if (f.kind !== "replica-lag") continue;
      if (Math.random() < f.probability) return f;
    }
    return null;
  }

  function pickSlowQueryFault(sql: string): SlowQueryFault | null {
    for (const f of config.faults) {
      if (f.kind !== "slow-query") continue;
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
    const values = (Array.isArray(valuesOrCb) ? valuesOrCb : undefined) as unknown[] | undefined;
    const now = Date.now();
    pruneRecentInserts(now);

    // Pool-exhaustion fault path.
    const poolFault = pickPoolExhaustionFault(sql);
    if (poolFault) {
      const hold = poolFault.holdMs ?? DEFAULT_HOLD_MS;
      stats.stuckActive++;
      stats.stuckTotal++;
      const client = await pool.connect();
      try {
        await new Promise((r) => setTimeout(r, hold));
        const result = await client.query(text as string, values);
        return result as QueryResult<QueryResultRow>;
      } finally {
        client.release();
        stats.stuckActive--;
      }
    }

    // Replica-lag path: intercept SELECT-by-id where the id was just
    // INSERTed. Return an empty result set as if the read replica
    // hasn't caught up yet.
    const isInsert = /^\s*INSERT\s+INTO/i.test(sql);
    const selectIdMatch = sql.match(/^\s*SELECT.+\bWHERE\s+id\s*=\s*\$(\d+)/i);
    if (selectIdMatch && values && values.length > 0) {
      const idIdx = Number(selectIdMatch[1]) - 1;
      const id = values[idIdx];
      if (typeof id === "string" && recentInserts.has(id)) {
        // The row IS recent. Decide whether this query trips the lag.
        const lagFault = pickReplicaLagFault();
        if (lagFault) {
          stats.lagHidden++;
          return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] } as QueryResult<QueryResultRow>;
        }
      }
    }

    // Slow-query path: uniform latency before delegating. Distinct
    // from pool-exhaustion (we don't pre-acquire a client) and from
    // replica-lag (the query still runs and returns its real rows).
    const slowFault = pickSlowQueryFault(sql);
    if (slowFault) {
      stats.slowed++;
      await new Promise((r) => setTimeout(r, slowFault.latencyMs ?? 2000));
    }

    const result = (await originalQuery(text as string, values)) as QueryResult<QueryResultRow>;

    // After running an INSERT, remember the id for replica-lag.
    if (isInsert && values && values.length > 0) {
      const id = values[0];
      if (typeof id === "string") {
        recentInserts.set(id, now);
      }
    }
    return result;
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
export function pgChaosStats(
  pool: Pool,
): { queries: number; stuckActive: number; stuckTotal: number; lagHidden: number; slowed: number } | null {
  const s = (pool as Pool & {
    __chaosStats?: { queries: number; stuckActive: number; stuckTotal: number; lagHidden: number; slowed: number };
  }).__chaosStats;
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
