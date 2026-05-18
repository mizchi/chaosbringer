/**
 * Target variant for the postgres-replica-lag scenario
 * (#119 Gap 1 follow-up — storage diversity / consistency model).
 *
 * Same Postgres backend as server.pg-pool.ts, different chaos: a
 * read-replica simulation that hides recently-INSERTed rows from
 * subsequent SELECTs for ~1.5s. The SPA's place-then-verify journey
 * trips this on most clicks — POST /orders returns 200 with the id,
 * but the immediate GET /verify/:id returns 404 because the chaos
 * engine is saying "the replica hasn't caught up yet."
 *
 * Pedagogical lesson: read-your-own-write violations exist whenever
 * the read path may hit a lagging replica. Mitigations:
 *   - Use INSERT ... RETURNING and serve the response from the same
 *     statement (no separate read needed)
 *   - Use a "prefer primary for N seconds after write" tag
 *   - Poll with bounded backoff and a small retry budget
 *   - Set a synchronous read consistency token (in real RDS, GTID/
 *     read-after-write tokens)
 *
 * Wrong direction: assuming POST /orders actually failed and
 * retrying (it didn't — the row IS in the database), or removing
 * the verify step (drops invariant coverage).
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
  // Bigger pool so this scenario isolates the consistency-model
  // failure from the pool-exhaustion failure.
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// 60% of recent-id SELECTs trip the replica-lag (return 0 rows for
// up to lagMs after the INSERT). On the place-then-verify journey
// this surfaces as the SPA showing status="missing" even though the
// row IS persisted in Postgres.
const chaosConfig =
  loadPgChaosConfig() ?? {
    faults: [{ kind: "replica-lag" as const, probability: 0.6, lagMs: 1500 }],
  };
pool = wrapPool(pool, chaosConfig);
console.error(
  `[pg-replica] pg-chaos installed: ${chaosConfig.faults.length} fault(s) — ` + JSON.stringify(chaosConfig.faults),
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

// Read path the SPA hits to verify. With replica-lag chaos this
// returns 404 for recently-inserted ids until lagMs has passed —
// the read-your-own-write violation.
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
    `target (pg-replica) listening on http://localhost:${info.port}. ` +
      `replica-lag p=0.6, lagMs=1500. /pg-chaos/stats for observability.`,
  );
});
