/**
 * Target variant for the disk-full scenario.
 *
 * Logs each request to /tmp/wom-orders-log.jsonl via fs.appendFileSync
 * on the customer path. Log volume is unbounded — no rotation, no
 * filtering. A "disk monitor" checks the log file size before each
 * write and returns 503 if it's exceeded a hardcoded cap (simulating
 * a real ENOSPC at OS level without filling actual disk).
 *
 * Correct mitigations:
 *   - Log rotation: truncate or rotate at a size threshold.
 *   - Drop verbose logging from the customer path entirely.
 *   - Move logs off the customer path (async batching, remote sink).
 *
 * Wrong directions:
 *   - Bump the cap (delays the problem).
 *   - Retry on 503 (writes can't succeed; cap is full).
 *   - Look at kumo / DDB (not the cause).
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { appendFileSync, statSync, existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { attachTracePropagation, honoTraceContext } from "@mizchi/aws-faults";
import { mountUI } from "./ui.ts";

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const TABLE = process.env.ORDERS_TABLE ?? "orders";
const LOG_PATH = process.env.LOG_PATH ?? "/tmp/wom-orders-log.jsonl";
// INTENTIONAL: hardcoded cap simulates a real ENOSPC threshold. In
// production this is the size of the disk partition; here it's
// 512KB so the scenario fires quickly. ~3KB per log entry,
// ~170 requests to fill it.
const LOG_CAP_BYTES = 512 * 1024;

// Clear log on boot so the scenario starts at a known state.
if (existsSync(LOG_PATH)) {
  try { unlinkSync(LOG_PATH); } catch { /* best-effort */ }
}

const ddb = new DynamoDBClient({ endpoint: ENDPOINT, region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
const doc = DynamoDBDocumentClient.from(ddb);
attachTracePropagation(ddb);

function diskUsage(): number {
  if (!existsSync(LOG_PATH)) return 0;
  try { return statSync(LOG_PATH).size; } catch { return 0; }
}

function logRequest(_line: object) {
  // MITIGATION: verbose per-request file logging removed from the
  // customer path. Was filling 512KB cap in ~170 requests with no
  // rotation. Use remote/async sink for debug telemetry instead.
  return;
}

const app = new Hono();
app.use("*", honoTraceContext);

async function writeOrder(): Promise<{ id: string }> {
  if (diskUsage() >= LOG_CAP_BYTES) {
    throw new Error(`ENOSPC: log volume cap (${LOG_CAP_BYTES} bytes) exceeded`);
  }
  const id = randomUUID();
  logRequest({ event: "order_received", id, ts: Date.now(), payload: { amount: 1 } });
  await doc.send(new PutCommand({ TableName: TABLE, Item: { id, ts: Date.now(), amount: 1 } }));
  logRequest({ event: "order_persisted", id, ts: Date.now() });
  return { id };
}

app.post("/health", async (c) => { try { const o = await writeOrder(); return c.json({ ok: true, ...o }); } catch (e) { return c.json({ ok: false, error: String(e) }, 503); } });
app.post("/orders", async (c) => { const b = await c.req.json().catch(() => ({})); try { const o = await writeOrder(); return c.json({ ...o, echo: b }); } catch (e) { return c.json({ ok: false, error: String(e) }, 503); } });
app.get("/verify/:id", async (c) => { const id = c.req.param("id"); try { const r = await doc.send(new GetCommand({ TableName: TABLE, Key: { id } })); return r.Item ? c.json(r.Item) : c.json({ error: "not found", id }, 404); } catch (e) { return c.json({ error: String(e) }, 503); } });

app.get("/__disk", (c) => c.json({ logPath: LOG_PATH, sizeBytes: diskUsage(), capBytes: LOG_CAP_BYTES, fullness: diskUsage() / LOG_CAP_BYTES }));

mountUI(app);
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (i) => console.error(`target (disk-full) :${i.port}. log volume cap ${LOG_CAP_BYTES} bytes; logs to ${LOG_PATH}. /__disk for observability.`));
