/**
 * Target variant for the clock-skew-rejection scenario.
 *
 * The target compares its local Date.now() to a "trusted time
 * service" (a small in-process pretend-NTP at /__time-truth that
 * returns Date.now() WITHOUT skew). Local Date.now() is wrapped
 * with a CLOCK_SKEW_MS offset that a previous debugging session
 * left in source. Every /orders request rejects if |local - truth|
 * > 5_000ms — and the skew is 30s, so every request rejects.
 *
 * The fix the agent should reach:
 *   - Remove the CLOCK_SKEW_MS shift (it's a leftover from a
 *     debug session, not load-bearing).
 *   - OR widen the tolerance (5s is too tight for a real
 *     production check).
 *   - OR remove the check entirely if it isn't required by the
 *     business rule.
 *
 * Diagnostic surface: /__clock returns local vs truth + skew.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { attachTracePropagation, honoTraceContext } from "@mizchi/aws-faults";
import { mountUI } from "./ui.ts";

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const TABLE = process.env.ORDERS_TABLE ?? "orders";

// INTENTIONAL WEAKNESS: a debug-session leftover. The skew shifts
// every Date.now() call by 30 seconds. Combined with a strict 5-
// second tolerance on the staleness check, every request fails.
const CLOCK_SKEW_MS = 30_000;
function localNow(): number { return Date.now() + CLOCK_SKEW_MS; }
const TOLERANCE_MS = 5_000;

const ddb = new DynamoDBClient({ endpoint: ENDPOINT, region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
const doc = DynamoDBDocumentClient.from(ddb);
attachTracePropagation(ddb);

const app = new Hono();
app.use("*", honoTraceContext);

// "Trusted" time, not skewed. The agent can compare this to the
// app's view via /__clock.
app.get("/__time-truth", (c) => c.json({ trustedMs: Date.now() }));

async function writeOrder(): Promise<{ id: string }> {
  // Compare local to truth before accepting. Rejects when too far.
  const truth = Date.now();
  if (Math.abs(localNow() - truth) > TOLERANCE_MS) {
    throw new Error(`clock-skew rejection: local=${localNow()} truth=${truth} diff=${Math.abs(localNow() - truth)}ms tolerance=${TOLERANCE_MS}ms`);
  }
  const id = randomUUID();
  await doc.send(new PutCommand({ TableName: TABLE, Item: { id, ts: localNow(), amount: 1 } }));
  return { id };
}

app.post("/health", async (c) => { try { const o = await writeOrder(); return c.json({ ok: true, ...o }); } catch (e) { return c.json({ ok: false, error: String(e) }, 503); } });
app.post("/orders", async (c) => { const b = await c.req.json().catch(() => ({})); try { const o = await writeOrder(); return c.json({ ...o, echo: b }); } catch (e) { return c.json({ ok: false, error: String(e) }, 503); } });
app.get("/verify/:id", async (c) => { const id = c.req.param("id"); try { const r = await doc.send(new GetCommand({ TableName: TABLE, Key: { id } })); return r.Item ? c.json(r.Item) : c.json({ error: "not found", id }, 404); } catch (e) { return c.json({ error: String(e) }, 503); } });

// Side-by-side observability the agent needs.
app.get("/__clock", (c) => {
  const truth = Date.now();
  const local = localNow();
  return c.json({ localMs: local, trustedMs: truth, skewMs: local - truth, toleranceMs: TOLERANCE_MS });
});

mountUI(app);
const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (i) => console.error(`target (clock-skew) :${i.port}. CLOCK_SKEW_MS=${CLOCK_SKEW_MS}, tolerance=${TOLERANCE_MS}. /__clock for observability.`));
