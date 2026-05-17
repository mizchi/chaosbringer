/**
 * Target app: Hono service backed by DynamoDB-via-kumo.
 * Writes orders via POST /orders. POST /health is the synthetic probe.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const TABLE = process.env.ORDERS_TABLE ?? "orders";

const client = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  maxAttempts: 1,
});
const doc = DynamoDBDocumentClient.from(client);

const app = new Hono();

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// App-level retry with long jittered backoff (>= feedback window 1s)
// to let throttle probability decay between attempts. Total attempts kept small.
async function writeOrder(): Promise<{ id: string }> {
  const id = randomUUID();
  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await doc.send(
        new PutCommand({
          TableName: TABLE,
          Item: { id, ts: Date.now(), amount: 1 },
        }),
      );
      return { id };
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts - 1) break;
      // Long backoff: 1.2-1.8s, exceeds feedback windowMs=1000.
      const delay = 1200 + Math.random() * 600;
      await sleep(delay);
    }
  }
  throw lastErr;
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

app.get("/", (c) => c.text("target up"));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.error(`target listening on http://localhost:${info.port} -> kumo at ${ENDPOINT}`);
});
