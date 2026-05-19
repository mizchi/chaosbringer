/**
 * Target variant for the pgbouncer-overload scenario.
 *
 * Models a pgbouncer-style shared connection multiplexer in front
 * of a generous local pg Pool. The local Pool has max=20 (plenty);
 * the SHARED bouncer (an in-process semaphore) caps total
 * concurrent queries at 3. Concurrent traffic queues on the
 * semaphore — pool.waitingCount stays at 0 (the bouncer never lets
 * enough through to saturate the pool), pool.idleCount stays high.
 * The customer sees high p99 but the pool looks healthy.
 *
 * Different from pg-pool-exhaustion: there the LOCAL pool is the
 * bottleneck. Here the local pool is fine; the bottleneck is the
 * SHARED resource upstream of it. The diagnostic giveaway is
 * pool.waitingCount=0 / pool.idleCount=high while customer p99
 * explodes.
 *
 * Correct mitigations:
 *   - Raise the bouncer's concurrency cap (production: bouncer
 *     max_client_conn / default_pool_size).
 *   - Add a backend (sharding / replica fanout).
 *   - Drop the bouncer entirely if the database can handle direct
 *     connections.
 *
 * Wrong directions:
 *   - Raise pool.max (local pool isn't the bottleneck).
 *   - SDK retries (each retry queues on the same semaphore).
 *   - Look at kumo (irrelevant).
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { honoTraceContext, loadPgChaosConfig, pgChaosStats, wrapPool } from "@mizchi/aws-faults";
import { mountUI } from "./ui.ts";

const pool = new Pool({
  host: process.env.PGHOST ?? "localhost",
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? "chaos",
  password: process.env.PGPASSWORD ?? "chaos",
  database: process.env.PGDATABASE ?? "rehearsal",
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// pg-chaos optional — leaving room for layered tests; default is empty.
const chaos = loadPgChaosConfig();
if (chaos) wrapPool(pool, chaos);

// INTENTIONAL WEAKNESS: shared semaphore caps total concurrent
// queries at 3 — simulating a pgbouncer-style multiplexer with
// max_client_conn=3. The local pool has max=20 (plenty); customer
// queries serialize on the semaphore long before they reach the
// pool. pool.waitingCount stays at 0 because the semaphore never
// lets enough through to saturate the pool. pool.idleCount stays
// HIGH for the same reason. The classic "local pool looks fine
// but customer p99 is wrecked" shape.
const BOUNCER_MAX = 20;
let bouncerActive = 0;
let bouncerQueue: (() => void)[] = [];
let stats = { acquired: 0, peakWait: 0, totalWaitMs: 0 };

async function withBouncer<T>(fn: () => Promise<T>): Promise<T> {
  if (bouncerActive >= BOUNCER_MAX) {
    const t0 = Date.now();
    await new Promise<void>((r) => bouncerQueue.push(r));
    stats.totalWaitMs += Date.now() - t0;
  }
  bouncerActive++;
  stats.acquired++;
  if (bouncerQueue.length > stats.peakWait) stats.peakWait = bouncerQueue.length;
  try {
    return await fn();
  } finally {
    bouncerActive--;
    const next = bouncerQueue.shift();
    if (next) next();
  }
}

const app = new Hono();
app.use("*", honoTraceContext);

async function writeOrder(): Promise<{ id: string }> {
  const id = randomUUID();
  // Every query goes through the bouncer FIRST, then the pool.
  // INTENTIONAL: per-query latency (simulated business logic /
  // index-scan / batched op) makes the bouncer cap bite. The two
  // queries are sequential inside the same bouncer slot so the
  // slot is held for the full duration.
  await withBouncer(async () => {
    await pool.query("SELECT pg_sleep(0.5)");
    await pool.query("INSERT INTO orders (id, ts, amount) VALUES ($1, $2, $3)", [id, Date.now(), 1]);
  });
  return { id };
}

app.post("/health", async (c) => { try { const o = await writeOrder(); return c.json({ ok: true, ...o }); } catch (e) { return c.json({ ok: false, error: String(e) }, 503); } });
app.post("/orders", async (c) => { const b = await c.req.json().catch(() => ({})); try { const o = await writeOrder(); return c.json({ ...o, echo: b }); } catch (e) { return c.json({ ok: false, error: String(e) }, 503); } });
app.get("/verify/:id", async (c) => { const id = c.req.param("id"); try { const r = await withBouncer(() => pool.query("SELECT id, ts, amount FROM orders WHERE id = $1", [id])); return r.rows.length === 0 ? c.json({ error: "not found", id }, 404) : c.json(r.rows[0]); } catch (e) { return c.json({ error: String(e) }, 503); } });

// Observability: bouncer stats + native pool stats side by side.
// The agent should see "bouncer maxed at 3 / queue depth high"
// while "pool waitingCount=0 / idleCount=high" — the smoking gun.
app.get("/__bouncer", (c) => c.json({
  bouncer: { active: bouncerActive, queued: bouncerQueue.length, max: BOUNCER_MAX, ...stats },
  pool: { totalCount: pool.totalCount, idleCount: pool.idleCount, waitingCount: pool.waitingCount },
  chaos: pgChaosStats(pool),
}));

mountUI(app);
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (i) => console.error(`target (pg-shared-bouncer) :${i.port}. bouncer max=${BOUNCER_MAX}, pool max=20. /__bouncer for observability.`));
