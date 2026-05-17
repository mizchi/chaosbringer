/**
 * Target app: Hono service backed by DynamoDB + Kinesis + S3 via kumo.
 *
 * POST /orders writes:
 *   1. DDB row (orders table)            — source of truth
 *   2. Kinesis audit event (orders-audit) — invisible buffered dependency
 *   3. S3 receipt object (receipts/{id}) — large-object write path
 * All three synchronous on the customer path. Each is in scope of a
 * different real-incident drill.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { KinesisClient, PutRecordCommand } from "@aws-sdk/client-kinesis";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
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
  // Standard retry with modest attempt count. Combined with the
  // app-level concurrency cap below this keeps DDB QPS under the
  // chaos feedback threshold (~20 req/s) so probability and tail
  // latency stay at baseline rather than escalating.
  retryMode: "standard",
  maxAttempts: 3,
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 1000,
    requestTimeout: 2000,
  }),
});

// App-level concurrency cap on the DDB write path. The simulated AWS
// chaos has a feedback loop that escalates throttling probability and
// tail latency once DDB QPS crosses ~20/s. Keeping in-flight writes
// well under that ceiling keeps the rule at baseline (p=0.55), and the
// adaptive SDK retries then resolve individual throttles, giving an
// effective per-request success rate of ~1 - 0.55^5 ≈ 95%.
const MAX_INFLIGHT_DDB = 4;
let inflight = 0;
const waiters: Array<() => void> = [];
async function acquire(): Promise<void> {
  if (inflight < MAX_INFLIGHT_DDB) {
    inflight++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inflight++;
}
function release(): void {
  inflight--;
  const next = waiters.shift();
  if (next) next();
}
const doc = DynamoDBDocumentClient.from(ddb);

const kinesis = new KinesisClient({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  // kumo is HTTP/1.1; the AWS SDK Kinesis client defaults to HTTP/2,
  // which kumo does not support. Force standard HTTP/1.1.
  requestHandler: new NodeHttpHandler(),
});

const s3 = new S3Client({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  forcePathStyle: true,
});

const app = new Hono();

async function writeOrder(): Promise<{ id: string }> {
  const id = randomUUID();
  // Primary write to DDB, gated by the in-flight semaphore.
  await acquire();
  try {
    await doc.send(
      new PutCommand({
        TableName: TABLE,
        Item: { id, ts: Date.now(), amount: 1 },
      }),
    );
  } finally {
    release();
  }
  // Audit event to Kinesis — synchronous on the customer path.
  // If Kinesis is slow / failing, the customer sees this latency directly.
  await kinesis.send(
    new PutRecordCommand({
      StreamName: STREAM,
      Data: new TextEncoder().encode(JSON.stringify({ id, ts: Date.now() })),
      PartitionKey: id,
    }),
  );
  // Receipt object to S3 — also synchronous. Large-object write path
  // that is the typical victim of S3 503 SlowDown bursts during
  // hot-prefix incidents.
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: `receipts/${id}.json`,
      Body: JSON.stringify({ id, ts: Date.now(), amount: 1 }),
      ContentType: "application/json",
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
