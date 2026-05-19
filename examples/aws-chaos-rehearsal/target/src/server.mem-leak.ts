/**
 * Target variant for the memory-leak-gradual scenario.
 *
 * No external chaos is needed; the bug is in the target's source.
 * Every request appends a ~256KB buffer to an in-process Map and
 * NEVER releases it. After a few hundred requests the heap is
 * gigabytes; GC pause times climb; p99 latency degrades; eventually
 * the Node process OOMs.
 *
 * Pedagogical axis this scenario adds: TIME-PROGRESSION awareness.
 * Every prior scenario presents a constant chaos signal during the
 * recovery window. Here the signal GETS WORSE over time — the agent
 * has to recognize the gradient and reason about cumulative state.
 *
 * Correct mitigations:
 *   1. Read the source, find the unbounded `recentRequests` Map,
 *      add an eviction policy (LRU, max size, TTL).
 *   2. Restart the target — buys time, but the leak returns. Used
 *      alone this would be only a temporary mitigation.
 *   3. Bound the buffer size or eliminate the retention entirely.
 *
 * Wrong directions:
 *   - Increase pool / SDK retry budgets (irrelevant; no upstream chaos)
 *   - Look at kumo chaos rules (none active)
 *   - Restart-only without fixing the leak (reflex; restart-trap shape)
 *
 * Observability: /__mem returns the leak counter so the agent can
 * confirm the leak exists and watch it grow.
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

const ddb = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
const doc = DynamoDBDocumentClient.from(ddb);
attachTracePropagation(ddb);

// INTENTIONAL WEAKNESS: every request appends a ~256KB buffer to
// this Map and never evicts. The data isn't used after the response
// is sent; this is a stateful debug-log pattern someone added
// "for observability" and forgot to bound.
const recentRequests = new Map<string, { ts: number; payload: Buffer }>();

const app = new Hono();
app.use("*", honoTraceContext);

async function writeOrder(): Promise<{ id: string }> {
  const id = randomUUID();
  // The leak: 256KB buffer retained per request.
  recentRequests.set(id, {
    ts: Date.now(),
    payload: Buffer.alloc(256 * 1024, "x"),
  });
  await doc.send(
    new PutCommand({ TableName: TABLE, Item: { id, ts: Date.now(), amount: 1 } }),
  );
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
    const res = await doc.send(new GetCommand({ TableName: TABLE, Key: { id } }));
    if (!res.Item) return c.json({ error: "not found", id }, 404);
    return c.json(res.Item);
  } catch (err) {
    return c.json({ error: String(err) }, 503);
  }
});

// Leak observability — the agent uses this to confirm the leak
// exists and watch it grow over time.
app.get("/__mem", (c) => {
  const mem = process.memoryUsage();
  return c.json({
    retainedRequests: recentRequests.size,
    retainedPayloadBytesApprox: recentRequests.size * 256 * 1024,
    heap: { used: mem.heapUsed, total: mem.heapTotal, rss: mem.rss },
  });
});

mountUI(app);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.error(
    `target (mem-leak) listening on http://localhost:${info.port}. ` +
      `Every request retains a 256KB buffer in memory. /__mem for leak observability.`,
  );
});
