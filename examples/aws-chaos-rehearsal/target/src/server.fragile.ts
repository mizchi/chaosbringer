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
import { S3Client, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { randomUUID } from "node:crypto";
import { attachTracePropagation, honoTraceContext } from "@mizchi/aws-faults";
import { mountUI } from "./ui.ts";

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const TABLE = process.env.ORDERS_TABLE ?? "orders";
const STREAM = process.env.AUDIT_STREAM ?? "orders-audit";
const BUCKET = process.env.RECEIPTS_BUCKET ?? "receipts";

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

const s3 = new S3Client({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  forcePathStyle: true,
});

const sts = new STSClient({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

const TIER_TABLE = process.env.TIER_TABLE ?? "tier-config";

// Propagate the inbound request's traceparent on every outgoing AWS
// call so kumo can record which trace hit which chaos rule. Wired on
// every SDK client this target uses.
for (const client of [ddb, kinesis, s3, sts]) {
  attachTracePropagation(client);
}

const app = new Hono();
app.use("*", honoTraceContext);

async function writeOrder(): Promise<{ id: string }> {
  const id = randomUUID();
  // Multi-tenant tier check via STS. Yes, calling STS on every customer
  // request is a control-plane dependency on the hot path — this is the
  // pattern that bit a lot of customers during the 2021 us-east-1 outage.
  await sts.send(new GetCallerIdentityCommand({}));
  // Tier config lookup. Reads a single hot key on every customer request
  // with NO local cache — the classic cache-stampede setup. Production
  // would put a TTL cache in front of this; we do not.
  await doc.send(
    new GetCommand({ TableName: TIER_TABLE, Key: { tenant: "default" } }),
  );
  // Primary write to DDB.
  await doc.send(
    new PutCommand({
      TableName: TABLE,
      Item: { id, ts: Date.now(), amount: 1 },
    }),
  );
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

// Per-order verify used by the journey-based customer probe.
// Returns 200 only if BOTH the DDB row AND the S3 receipt for the
// just-placed id exist. A "fire-and-forget" mitigation that drops
// receipt durability (the wrong-shortcut for the S3 incident
// scenarios) leaves the row but not the receipt — this endpoint
// catches that gap so the customer-impact rubric flags it.
app.get("/verify/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const row = await doc.send(new GetCommand({ TableName: TABLE, Key: { id } }));
    if (!row.Item) return c.json({ error: "row missing", id }, 404);
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: `receipts/${id}.json` }));
    return c.json({ id, row: row.Item });
  } catch (err) {
    const msg = String(err);
    if (/NotFound|NoSuchKey|404/.test(msg)) {
      return c.json({ error: "receipt missing", id }, 404);
    }
    return c.json({ error: msg, id }, 503);
  }
});

mountUI(app);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.error(`target listening on http://localhost:${info.port} -> kumo at ${ENDPOINT}`);
});
