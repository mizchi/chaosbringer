/**
 * Target variant for the postgres-pool-exhaustion scenario
 * (#119 Gap 1 — storage diversity).
 *
 * Uses real PostgreSQL via the `pg` Pool client, with chaos applied
 * via the wrapPool middleware (see @mizchi/aws-faults/pg-chaos).
 * When pool-exhaustion is configured (via PG_CHAOS_CONFIG env var
 * at process startup), some fraction of /orders calls hold their
 * borrowed connection for an absurdly long time — exhausting the
 * pool's max connections and queuing every other order behind them.
 *
 * Pedagogical novelty (vs the DDB-based scenarios):
 *   - Symptom is "everything is slow / queues forever", not a
 *     specific error code. The agent has to look at PG-side state
 *     (active queries, pool state) rather than reading an SDK error.
 *   - Mitigation lives in the POOL CONFIG (max, idleTimeoutMs,
 *     statement_timeout, query timeout) and the WAITER LOGIC (kill
 *     long-running queries via pg_terminate_backend, or set
 *     statement_timeout at the session level), not in the AWS SDK.
 *   - Different recovery vocabulary: drain pool / raise max / kill
 *     long queries — a real on-call skill that doesn't appear
 *     anywhere else in the catalog.
 *
 * Default pool config (intentionally tight):
 *   - max: 5
 *   - idleTimeoutMillis: 30_000
 *   - connectionTimeoutMillis: 5_000
 *
 * To run this variant manually with chaos enabled:
 *   PG_CHAOS_CONFIG='{"faults":[{"kind":"pool-exhaustion","probability":0.15}]}' \
 *     npx tsx target/src/server.pg-pool.ts
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { honoTraceContext, loadPgChaosConfig, pgChaosStats, wrapPool } from "@mizchi/aws-faults";

const PG_HOST = process.env.PGHOST ?? "localhost";
const PG_PORT = Number(process.env.PGPORT ?? 5432);
const PG_USER = process.env.PGUSER ?? "chaos";
const PG_PASSWORD = process.env.PGPASSWORD ?? "chaos";
const PG_DATABASE = process.env.PGDATABASE ?? "rehearsal";

let pool = new Pool({
  host: PG_HOST,
  port: PG_PORT,
  user: PG_USER,
  password: PG_PASSWORD,
  database: PG_DATABASE,
  max: 5, // INTENTIONAL: small pool. Realistic for tight prod budgets;
  // amplifies pool-exhaustion chaos.
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// Default chaos config baked into the variant: 15% of orders hold
// their pg connection for 60s before releasing. With pool max=5
// and steady traffic, this exhausts the pool within ~10 requests
// and queues every subsequent order behind the held connections.
// Override at runtime via PG_CHAOS_CONFIG env var (e.g. to disable
// for local development).
const chaosConfig =
  loadPgChaosConfig() ?? {
    faults: [{ kind: "pool-exhaustion" as const, probability: 0.4, holdMs: 30_000 }],
  };
pool = wrapPool(pool, chaosConfig);
console.error(
  `[pg-pool] pg-chaos installed: ${chaosConfig.faults.length} fault(s) — ` + JSON.stringify(chaosConfig.faults),
);

const app = new Hono();
app.use("*", honoTraceContext);

async function writeOrder(): Promise<{ id: string }> {
  const id = randomUUID();
  await pool.query("INSERT INTO orders (id, ts, amount) VALUES ($1, $2, $3)", [id, Date.now(), 1]);
  return { id };
}

app.post("/health", async (c) => {
  try {
    const out = await writeOrder();
    return c.json({ ok: true, ...out });
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 503);
  }
});

app.post("/orders", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const out = await writeOrder();
    return c.json({ ...out, echo: body });
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 503);
  }
});

app.get("/verify/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const r = await pool.query("SELECT id, ts, amount FROM orders WHERE id = $1", [id]);
    if (r.rows.length === 0) return c.json({ error: "not found", id }, 404);
    return c.json(r.rows[0]);
  } catch (err) {
    return c.json({ error: String(err) }, 503);
  }
});

// Observability the agent can hit to see pool state. Mirrors kumo's
// /kumo/chaos/stats — without it the chaos is invisible from the
// outside (the agent only sees timeouts).
app.get("/pg-chaos/stats", (c) => {
  const s = pgChaosStats(pool);
  // pg's Pool exposes some runtime stats too: totalCount, idleCount,
  // waitingCount. Surface those alongside so the agent can see
  // "5 of 5 connections active, 12 requests waiting".
  // These properties live on the underlying pg Pool — wrapPool
  // returns the same object, just with chaos hooks installed.
  return c.json({
    chaos: s,
    pool: {
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
    },
  });
});

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.error(
    `target (pg-pool) listening on http://localhost:${info.port}. ` +
      `pool max=5; /pg-chaos/stats for pool observability.`,
  );
});
