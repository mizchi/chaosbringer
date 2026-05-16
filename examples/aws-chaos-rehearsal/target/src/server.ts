/**
 * Target app: minimal Hono service backed by DynamoDB-via-kumo.
 *
 * POST /orders writes an order row. POST /health is the synthetic probe the
 * drill uses to measure SLO — it also exercises the write path, so any DDB
 * fault shows up immediately.
 *
 * This file is INTENTIONALLY written without any retry caps, circuit
 * breakers, or queueing. It is the broken baseline the AI agent has to
 * harden. Look at the comments marked "INTENTIONAL WEAKNESS" — those are
 * the dials we expect a recovery action to turn.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const TABLE = process.env.ORDERS_TABLE ?? "orders";

// INTENTIONAL WEAKNESS #1: default SDK retry config. With throttling at 50%
// and unbounded retries, a single user request can trigger a small retry
// burst that itself drives more throttling.
const client = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
const doc = DynamoDBDocumentClient.from(client);

const app = new Hono();

// INTENTIONAL WEAKNESS #2: every probe directly drives a real DDB write.
// A circuit breaker or coalescing layer would absorb most of the chaos.
async function writeOrder(): Promise<{ id: string }> {
  const id = randomUUID();
  await doc.send(
    new PutCommand({
      TableName: TABLE,
      Item: { id, ts: Date.now(), amount: 1 },
    }),
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
  const out = await writeOrder();
  return c.json({ ...out, echo: body });
});

app.get("/", (c) => c.text("target up"));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.error(`target listening on http://localhost:${info.port} -> kumo at ${ENDPOINT}`);
});
