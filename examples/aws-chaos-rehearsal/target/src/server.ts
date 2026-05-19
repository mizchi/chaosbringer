/**
 * Target variant for the schema-mismatch scenario.
 *
 * Models a rolling-deploy gone wrong: two write paths are active.
 * 50% of POST /orders go through the v1 write (Item: {id, ts,
 * amount}) and 50% through v2 (Item: {id, ts, amount, version: 2,
 * checksum}). The /verify/:id path expects v2 (`version` field
 * must equal 2 and `checksum` must match). v1 rows show up as
 * 404 from /verify even though they ARE in DDB.
 *
 * In a real deploy this looks like: half your nodes are running
 * old code, half new; the new schema isn't backwards-compatible;
 * the reader (older or newer; could be either side) breaks.
 *
 * Correct mitigations:
 *   - Read-path backward-compat shim: accept v1 OR v2 in /verify.
 *   - Rollback to the v1 writer (uniform schema, lose v2 fields).
 *   - Finish the migration (uniform v2, backfill v1 rows).
 *
 * Wrong directions:
 *   - SDK retries (rows don't change shape on retry).
 *   - Pool tuning / kumo inspection (not the cause).
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID, createHash } from "node:crypto";
import { attachTracePropagation, honoTraceContext } from "@mizchi/aws-faults";
import { mountUI } from "./ui.ts";

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const TABLE = process.env.ORDERS_TABLE ?? "orders";
const ddb = new DynamoDBClient({ endpoint: ENDPOINT, region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
const doc = DynamoDBDocumentClient.from(ddb);
attachTracePropagation(ddb);

const app = new Hono();
app.use("*", honoTraceContext);

function checksum(id: string, ts: number, amount: number): string {
  return createHash("sha256").update(`${id}:${ts}:${amount}`).digest("hex").slice(0, 16);
}

// INTENTIONAL WEAKNESS: 50/50 split between v1 and v2 schemas.
// Imagine half your nodes still run old code.
let stats = { v1Writes: 0, v2Writes: 0, v1Reads404: 0, v2Reads200: 0 };
async function writeOrder(): Promise<{ id: string; schemaVersion: number }> {
  const id = randomUUID();
  const ts = Date.now();
  const useV2 = Math.random() < 0.5;
  if (useV2) {
    stats.v2Writes++;
    await doc.send(new PutCommand({ TableName: TABLE, Item: { id, ts, amount: 1, version: 2, checksum: checksum(id, ts, 1) } }));
    return { id, schemaVersion: 2 };
  } else {
    stats.v1Writes++;
    await doc.send(new PutCommand({ TableName: TABLE, Item: { id, ts, amount: 1 } }));
    return { id, schemaVersion: 1 };
  }
}

app.post("/health", async (c) => { try { const o = await writeOrder(); return c.json({ ok: true, ...o }); } catch (e) { return c.json({ ok: false, error: String(e) }, 503); } });
app.post("/orders", async (c) => { const b = await c.req.json().catch(() => ({})); try { const o = await writeOrder(); return c.json({ ...o, echo: b }); } catch (e) { return c.json({ ok: false, error: String(e) }, 503); } });

// INTENTIONAL: verify only accepts v2. v1 rows look "missing"
// from the customer's perspective.
app.get("/verify/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const r = await doc.send(new GetCommand({ TableName: TABLE, Key: { id } }));
    if (!r.Item) return c.json({ error: "not found", id }, 404);
    const row = r.Item as { id: string; ts: number; amount: number; version?: number; checksum?: string };
    // Read-path backward-compat shim: accept v1 rows (no version)
    // during rolling deploy. v2 rows still validated by checksum.
    if (row.version === 2) {
      if (row.checksum !== checksum(row.id, row.ts, row.amount)) {
        return c.json({ error: "checksum mismatch", id }, 400);
      }
      stats.v2Reads200++;
      return c.json(row);
    }
    // v1 row — treat as valid placed order.
    stats.v2Reads200++;
    return c.json({ ...row, version: row.version ?? 1 });
  } catch (e) { return c.json({ error: String(e) }, 503); }
});

app.get("/__schema-stats", (c) => c.json(stats));

mountUI(app);
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (i) => console.error(`target (schema-mismatch) :${i.port}. v1/v2 50:50 writes; /verify only accepts v2. /__schema-stats for observability.`));
