/**
 * Target app: Hono service backed by DynamoDB + Kinesis + S3 + STS via kumo.
 *
 * POST /orders does:
 *   0. STS GetCallerIdentity — "tenant tier check" (control-plane call)
 *   1. DDB row (orders table)            — source of truth
 *   2. Kinesis audit event (orders-audit) — invisible buffered dependency
 *   3. S3 receipt object (receipts/{id}) — large-object write path
 * All four synchronous on the customer path. Each is in scope of a
 * different real-incident drill (2021 / 2015 / 2020 / 2017 respectively).
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { KinesisClient, PutRecordCommand } from "@aws-sdk/client-kinesis";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { randomUUID } from "node:crypto";

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const TABLE = process.env.ORDERS_TABLE ?? "orders";
const STREAM = process.env.AUDIT_STREAM ?? "orders-audit";
const BUCKET = process.env.RECEIPTS_BUCKET ?? "receipts";

const ddb = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  maxAttempts: 8,
});
const doc = DynamoDBDocumentClient.from(ddb);

const kinesis = new KinesisClient({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  // kumo is HTTP/1.1; the AWS SDK Kinesis client defaults to HTTP/2,
  // which kumo does not support. Force standard HTTP/1.1.
  requestHandler: new NodeHttpHandler(),
  maxAttempts: 6,
});

const s3 = new S3Client({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  forcePathStyle: true,
  maxAttempts: 6,
});

const sts = new STSClient({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  maxAttempts: 6,
});

const TIER_TABLE = process.env.TIER_TABLE ?? "tier-config";

const app = new Hono();

async function retry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err);
      const retryable = /Throughput|Throttl|ServiceUnavailable|InternalServer|SlowDown|TimeoutError|ECONNRESET|503|500/i.test(msg);
      if (!retryable || i === attempts - 1) throw err;
      const backoff = Math.min(50 * Math.pow(2, i), 800) + Math.floor(Math.random() * 50);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

async function writeOrder(): Promise<{ id: string }> {
  const id = randomUUID();
  // Multi-tenant tier check via STS. Yes, calling STS on every customer
  // request is a control-plane dependency on the hot path — this is the
  // pattern that bit a lot of customers during the 2021 us-east-1 outage.
  await retry(() => sts.send(new GetCallerIdentityCommand({})));
  await retry(() =>
    doc.send(
      new GetCommand({ TableName: TIER_TABLE, Key: { tenant: "default" } }),
    ),
  );
  await retry(() =>
    doc.send(
      new PutCommand({
        TableName: TABLE,
        Item: { id, ts: Date.now(), amount: 1 },
      }),
    ),
  );
  await retry(() =>
    kinesis.send(
      new PutRecordCommand({
        StreamName: STREAM,
        Data: new TextEncoder().encode(JSON.stringify({ id, ts: Date.now() })),
        PartitionKey: id,
      }),
    ),
  );
  await retry(() =>
    s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: `receipts/${id}.json`,
        Body: JSON.stringify({ id, ts: Date.now(), amount: 1 }),
        ContentType: "application/json",
      }),
    ),
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

app.get("/", (c) => c.text("target up"));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.error(`target listening on http://localhost:${info.port} -> kumo at ${ENDPOINT}`);
});
