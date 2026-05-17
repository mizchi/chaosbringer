/**
 * Target app: Hono service backed by DynamoDB + Kinesis-via-kumo.
 *
 * Writes orders via POST /orders (which writes a DDB row AND a Kinesis
 * audit event, synchronously). POST /health is the synthetic probe and
 * exercises the same path.
 *
 * The Kinesis audit publish was added so the morningRushCognito drill
 * (2020 us-east-1 replay) has something to bite. It's intentionally
 * synchronous and unbounded — exactly the "invisible hidden
 * dependency" pattern the 2020 incident exposed.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { KinesisClient, PutRecordCommand } from "@aws-sdk/client-kinesis";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { randomUUID } from "node:crypto";

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const TABLE = process.env.ORDERS_TABLE ?? "orders";
const STREAM = process.env.AUDIT_STREAM ?? "orders-audit";

const ddb = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
const doc = DynamoDBDocumentClient.from(ddb);

const kinesis = new KinesisClient({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  // kumo is HTTP/1.1; the AWS SDK Kinesis client defaults to HTTP/2,
  // which kumo does not support. Force standard HTTP/1.1.
  requestHandler: new NodeHttpHandler(),
});

const app = new Hono();

async function writeOrder(): Promise<{ id: string }> {
  const id = randomUUID();
  // Primary write to DDB — still synchronous (source of truth).
  await doc.send(
    new PutCommand({
      TableName: TABLE,
      Item: { id, ts: Date.now(), amount: 1 },
    }),
  );
  // Audit event to Kinesis — detached from the customer path.
  // Kinesis is a non-critical audit sink. If it is slow/failing we must
  // not block or fail the customer. Fire-and-forget with a short timeout;
  // swallow errors and surface them only in logs.
  const auditPromise = kinesis.send(
    new PutRecordCommand({
      StreamName: STREAM,
      Data: new TextEncoder().encode(JSON.stringify({ id, ts: Date.now() })),
      PartitionKey: id,
    }),
  );
  // Attach a handler so unhandled rejections don't crash the process.
  auditPromise.catch((err) => {
    console.error(`audit publish failed for ${id}: ${String(err)}`);
  });
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

app.get("/", (c) => c.text("target up"));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.error(`target listening on http://localhost:${info.port} -> kumo at ${ENDPOINT}`);
});
