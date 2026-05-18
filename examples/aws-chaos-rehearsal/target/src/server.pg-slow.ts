/**
 * Target variant for the pg-slow-writes scenario
 * (#119 Gap 1 / slow-query inject kind — vacuum-lock pattern).
 *
 * Real Postgres backend, generous pool (max=20), no replica-lag —
 * the only chaos active is slow-query on INSERT/UPDATE. Reads are
 * fast; writes take ~4s with 40% probability. Models the
 * vacuum-lock / busy-table / missing-index-on-write pattern.
 *
 * Pedagogical contrast vs pg-pool-exhaustion:
 *   - Pool isn't blocked — pool.totalCount cycles fine.
 *   - waitingCount stays at 0; only the in-flight query is slow.
 *   - Customer p99 explodes; the agent sees this clearly.
 *
 * Pedagogical contrast vs pg-replica-lag:
 *   - Rows ARE returned by SELECTs; no missing data.
 *   - Writes themselves are slow, not the read-after-write step.
 *
 * Correct mitigations (any of):
 *   1. Add `SET LOCAL statement_timeout` per session/query so long
 *      writes get killed → faster failure surface, but the row
 *      doesn't land. App must surface the failure to the customer.
 *   2. Make the write async (write-ahead queue) with bounded
 *      backlog. The customer endpoint returns quickly, the queue
 *      drains in the background. Durability tradeoff to think about.
 *   3. Wrap the query with AbortController timeout (Node-side) to
 *      cap the customer-path latency.
 *
 * Wrong directions:
 *   - Adding pool.max — pool isn't the bottleneck.
 *   - Application-level retries — each retry hits the same slow
 *     query; aggregate customer wait gets WORSE.
 *   - Looking for kumo chaos rules — not involved.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { honoTraceContext, loadPgChaosConfig, pgChaosStats, wrapPool } from "@mizchi/aws-faults";
import { mountUI } from "./ui.ts";

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
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// 40% of INSERT/UPDATE queries take ~4 seconds. SELECTs unaffected.
// Models a table mid-VACUUM or with write-lock contention.
const chaosConfig =
  loadPgChaosConfig() ?? {
    faults: [
      {
        kind: "slow-query" as const,
        probability: 0.4,
        latencyMs: 4000,
        matchSql: "^\\s*(INSERT|UPDATE)",
      },
    ],
  };
pool = wrapPool(pool, chaosConfig);
console.error(
  `[pg-slow] pg-chaos installed: ${chaosConfig.faults.length} fault(s) — ` + JSON.stringify(chaosConfig.faults),
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

app.get("/pg-chaos/stats", (c) => {
  const s = pgChaosStats(pool);
  return c.json({
    chaos: s,
    pool: {
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
    },
  });
});

mountUI(app);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.error(
    `target (pg-slow) listening on http://localhost:${info.port}. ` +
      `slow-query p=0.4 latencyMs=4000 on INSERT/UPDATE. /pg-chaos/stats for observability.`,
  );
});
