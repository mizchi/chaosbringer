/**
 * Target variant for the cache-stampede-on-expiry scenario.
 *
 * Has an in-process tier-config cache with a 5-second TTL. When TTL
 * expires, the FIRST request that misses goes to DDB; if DDB is slow
 * (kumo applies p99=3s latency to GetItem on tier-config), MORE
 * concurrent requests miss while the first is still in flight. They
 * ALL hit DDB. Customer p99 explodes; DDB sees a burst of GetItems
 * every TTL boundary.
 *
 * The fix is the singleflight / coalesce pattern: dedupe concurrent
 * misses by sharing one in-flight Promise per cache key. This is
 * different from tier-lookup-stampede (which is "ADD a cache" with
 * no cache present at all); here a cache exists but its expiry
 * behavior is wrong.
 *
 * Correct mitigations:
 *   1. Singleflight: in-flight misses share one Promise per key.
 *   2. Probabilistic early refresh (XFetch).
 *   3. Soft + hard TTL: serve stale-but-recent on miss, refresh in
 *      the background.
 *
 * Wrong directions:
 *   - Raise pool size (the pool isn't the bottleneck; the upstream is).
 *   - Disable cache (kills latency-amortization on hit too).
 *   - Bump kumo latency-rule chaos in target source (cheating).
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { attachTracePropagation, honoTraceContext } from "@mizchi/aws-faults";
import { mountUI } from "./ui.ts";

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const TABLE = process.env.ORDERS_TABLE ?? "orders";
const TIER_TABLE = process.env.TIER_TABLE ?? "tier-config";

const ddb = new DynamoDBClient({ endpoint: ENDPOINT, region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
const doc = DynamoDBDocumentClient.from(ddb);
attachTracePropagation(ddb);

// INTENTIONAL WEAKNESS: cache with TTL but no singleflight.
// Every miss kicks off its own GetItem; under upstream latency,
// concurrent misses stampede.
const TIER_TTL_MS = 5_000;
let tierCache: { value: unknown; expiresAt: number } | null = null;
let cacheStats = { hits: 0, misses: 0, inflight: 0, stampedeBursts: 0 };

async function getTier(): Promise<unknown> {
  const now = Date.now();
  if (tierCache && tierCache.expiresAt > now) {
    cacheStats.hits++;
    return tierCache.value;
  }
  cacheStats.misses++;
  if (cacheStats.inflight > 0) cacheStats.stampedeBursts++;
  cacheStats.inflight++;
  try {
    const res = await doc.send(new GetCommand({ TableName: TIER_TABLE, Key: { tenant: "default" } }));
    tierCache = { value: res.Item ?? { tenant: "default" }, expiresAt: Date.now() + TIER_TTL_MS };
    return tierCache.value;
  } finally {
    cacheStats.inflight--;
  }
}

const app = new Hono();
app.use("*", honoTraceContext);

async function writeOrder(): Promise<{ id: string }> {
  const id = randomUUID();
  await getTier();
  await doc.send(new PutCommand({ TableName: TABLE, Item: { id, ts: Date.now(), amount: 1 } }));
  return { id };
}

app.post("/health", async (c) => { try { const o = await writeOrder(); return c.json({ ok: true, ...o }); } catch (e) { return c.json({ ok: false, error: String(e) }, 503); } });
app.post("/orders", async (c) => { const b = await c.req.json().catch(() => ({})); try { const o = await writeOrder(); return c.json({ ...o, echo: b }); } catch (e) { return c.json({ ok: false, error: String(e) }, 503); } });
app.get("/verify/:id", async (c) => { const id = c.req.param("id"); try { const r = await doc.send(new GetCommand({ TableName: TABLE, Key: { id } })); return r.Item ? c.json(r.Item) : c.json({ error: "not found", id }, 404); } catch (e) { return c.json({ error: String(e) }, 503); } });

app.get("/__cache", (c) => c.json({ ttlMs: TIER_TTL_MS, ...cacheStats, currentlyInflight: cacheStats.inflight }));

mountUI(app);
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (i) => console.error(`target (cache-stampede) :${i.port}. tier cache TTL=${TIER_TTL_MS}ms, no singleflight. /__cache for observability.`));
