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
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

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

const app = new Hono();

// Write-ahead log for S3 receipt writes. Receipts must not be lost
// (downstream consumer sends emails from them), but they don't have
// to be in S3 by the time we ack the customer. We durably stage to
// disk first; a background worker drains to S3 with retries.
const WAL_PATH = process.env.RECEIPT_WAL ?? "/tmp/receipt-wal.ndjson";
if (!existsSync(dirname(WAL_PATH))) mkdirSync(dirname(WAL_PATH), { recursive: true });
if (!existsSync(WAL_PATH)) writeFileSync(WAL_PATH, "");

function walAppend(entry: { id: string; body: string }) {
  appendFileSync(WAL_PATH, JSON.stringify(entry) + "\n");
}

async function drainWal() {
  let lines: string[];
  try {
    lines = readFileSync(WAL_PATH, "utf8").split("\n").filter((l) => l.length > 0);
  } catch {
    return;
  }
  if (lines.length === 0) return;
  const remaining: string[] = [];
  for (const line of lines) {
    let entry: { id: string; body: string };
    try { entry = JSON.parse(line); } catch { continue; }
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: `receipts/${entry.id}.json`,
          Body: entry.body,
          ContentType: "application/json",
        }),
      );
    } catch {
      remaining.push(line);
    }
  }
  // Rewrite WAL with only undrained entries. Atomic-ish: write tmp then rename.
  const tmp = WAL_PATH + ".tmp";
  writeFileSync(tmp, remaining.length ? remaining.join("\n") + "\n" : "");
  // Use rename via fs.renameSync
  try { (require("node:fs") as typeof import("node:fs")).renameSync(tmp, WAL_PATH); } catch {}
}

setInterval(() => { drainWal().catch(() => {}); }, 1000);

async function writeOrder(): Promise<{ id: string }> {
  const id = randomUUID();
  // Primary write to DDB — source of truth, must be synchronous.
  await doc.send(
    new PutCommand({
      TableName: TABLE,
      Item: { id, ts: Date.now(), amount: 1 },
    }),
  );
  // Audit event to Kinesis — regulatory; keep synchronous.
  await kinesis.send(
    new PutRecordCommand({
      StreamName: STREAM,
      Data: new TextEncoder().encode(JSON.stringify({ id, ts: Date.now() })),
      PartitionKey: id,
    }),
  );
  // Receipt object: durable write-ahead log to disk, then background
  // worker drains to S3. Receipt data is not lost on S3 outage.
  const body = JSON.stringify({ id, ts: Date.now(), amount: 1 });
  walAppend({ id, body });
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
