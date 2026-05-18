/**
 * Target for the silent-data-loss scenario (Byzantine faults).
 *
 * Same shape as server.fragile.ts but adds an in-process counter of
 * "writes the target THINKS succeeded" plus a /verify endpoint that
 * cross-checks that count against the actual DDB row count (Scan).
 *
 * Under a silent-success chaos rule on PutItem, kumo returns 200 OK
 * without invoking the real handler. The target sees success and
 * increments writesAcked++. /verify shows writesAcked > ddbRowCount —
 * the Byzantine signal.
 *
 * The customer-facing /orders endpoint returns 200 with the new id,
 * so customers think their order was placed. The probe shows healthy.
 * Only /verify catches the data loss.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const TABLE = process.env.ORDERS_TABLE ?? "orders";

const ddb = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
const doc = DynamoDBDocumentClient.from(ddb);

// Local telemetry for /verify.
let writesAcked = 0;

const app = new Hono();

async function writeOrder(): Promise<{ id: string }> {
  const id = randomUUID();
  await doc.send(
    new PutCommand({
      TableName: TABLE,
      Item: { id, ts: Date.now(), amount: 1 },
    }),
  );
  // The client got a 200 response. Increment the "writes we believe
  // succeeded" counter.
  writesAcked++;
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

// Cross-check endpoint. Counts actual DDB rows via Scan and reports
// the gap between writes-acked and rows-actually-persisted. If chaos
// is honest (real success or real failure), gap == 0. If chaos is
// Byzantine (silent-success), gap > 0.
app.get("/verify", async (c) => {
  try {
    const res = await ddb.send(new ScanCommand({ TableName: TABLE, Select: "COUNT" }));
    const ddbCount = res.Count ?? 0;
    const lost = Math.max(0, writesAcked - ddbCount);
    return c.json({ writesAcked, ddbCount, lost });
  } catch (err) {
    return c.json({ writesAcked, error: String(err) }, 503);
  }
});

app.get("/", (c) => c.text("target up (silent-loss baseline)"));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.error(`target (silent-loss) listening on http://localhost:${info.port}`);
});
