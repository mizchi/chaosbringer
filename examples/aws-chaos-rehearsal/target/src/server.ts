/**
 * Target app: Hono service backed by DynamoDB + Kinesis + S3 via kumo.
 *
 * POST /orders writes:
 *   1. DDB row (orders table)            — source of truth (CRITICAL, sync)
 *   2. Kinesis audit event (orders-audit) — regulatory; durable spool + async flush
 *   3. S3 receipt object (receipts/{id}) — customer-recoverable; durable spool + async flush
 *
 * Mitigation pattern (s3-index-down incident):
 *   DDB remains synchronous (source of truth).
 *   Kinesis + S3 writes are first persisted to a local write-ahead spool
 *   on disk and then attempted asynchronously. If the AWS call fails, the
 *   spool entry remains and a background replayer retries it. This preserves
 *   durability (no data loss) without coupling customer latency to S3/Kinesis.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { KinesisClient, PutRecordCommand } from "@aws-sdk/client-kinesis";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const TABLE = process.env.ORDERS_TABLE ?? "orders";
const STREAM = process.env.AUDIT_STREAM ?? "orders-audit";
const BUCKET = process.env.RECEIPTS_BUCKET ?? "receipts";

const SPOOL_DIR = process.env.SPOOL_DIR ?? "/tmp/target-spool";
mkdirSync(SPOOL_DIR, { recursive: true });

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
  requestHandler: new NodeHttpHandler(),
});

const s3 = new S3Client({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  forcePathStyle: true,
});

const app = new Hono();

type SpoolEntry = {
  id: string;
  ts: number;
  amount: number;
  kinesisDone: boolean;
  s3Done: boolean;
};

function spoolPath(id: string): string {
  return join(SPOOL_DIR, `${id}.json`);
}

function persistSpool(entry: SpoolEntry): void {
  // Write-ahead: this is the durability guarantee. If the process dies after
  // this point, the replayer on next start will flush it to AWS.
  writeFileSync(spoolPath(entry.id), JSON.stringify(entry));
}

async function tryFlush(entry: SpoolEntry): Promise<void> {
  let mutated = false;
  if (!entry.kinesisDone) {
    try {
      await kinesis.send(
        new PutRecordCommand({
          StreamName: STREAM,
          Data: new TextEncoder().encode(
            JSON.stringify({ id: entry.id, ts: entry.ts }),
          ),
          PartitionKey: entry.id,
        }),
      );
      entry.kinesisDone = true;
      mutated = true;
    } catch {
      // Leave spool entry for replay.
    }
  }
  if (!entry.s3Done) {
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: `receipts/${entry.id}.json`,
          Body: JSON.stringify({
            id: entry.id,
            ts: entry.ts,
            amount: entry.amount,
          }),
          ContentType: "application/json",
        }),
      );
      entry.s3Done = true;
      mutated = true;
    } catch {
      // Leave spool entry for replay.
    }
  }
  if (entry.kinesisDone && entry.s3Done) {
    try {
      unlinkSync(spoolPath(entry.id));
    } catch {
      /* ignore */
    }
  } else if (mutated) {
    persistSpool(entry);
  }
}

async function writeOrder(): Promise<{ id: string }> {
  const id = randomUUID();
  const ts = Date.now();
  // 1. Primary write to DDB (source of truth, synchronous).
  await doc.send(
    new PutCommand({
      TableName: TABLE,
      Item: { id, ts, amount: 1 },
    }),
  );
  // 2. Persist durable spool entry for the side-effect writes. Done BEFORE
  //    we attempt them so we never lose audit/receipt data.
  const entry: SpoolEntry = {
    id,
    ts,
    amount: 1,
    kinesisDone: false,
    s3Done: false,
  };
  persistSpool(entry);
  // 3. Best-effort flush in the background. We do not await; customer
  //    latency is decoupled from S3/Kinesis health. The background replayer
  //    will retry anything that fails.
  void tryFlush(entry).catch(() => {});
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

// Background replayer: every 2s, sweep the spool and retry pending entries.
async function replayLoop(): Promise<void> {
  while (true) {
    try {
      const files = readdirSync(SPOOL_DIR).filter((f) => f.endsWith(".json"));
      for (const f of files) {
        try {
          const raw = readFileSync(join(SPOOL_DIR, f), "utf8");
          const entry = JSON.parse(raw) as SpoolEntry;
          await tryFlush(entry);
        } catch {
          /* skip broken file */
        }
      }
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}
void replayLoop();

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.error(
    `target listening on http://localhost:${info.port} -> kumo at ${ENDPOINT}`,
  );
});
