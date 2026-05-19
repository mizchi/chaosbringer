/**
 * Target variant for the regex-backtrack-dos scenario.
 *
 * The bug is a single-line catastrophic-backtracking regex applied
 * to the order body. When the body contains a string that matches
 * the regex's nested-quantifier pattern (e.g. a long sequence of
 * 'a' followed by '!'), V8's regex engine consumes seconds of CPU
 * per call. With concurrent traffic this pins the event loop and
 * every customer order times out.
 *
 * Real-world analogs (a.k.a. ReDoS — Regular expression Denial of
 * Service):
 *   - Cloudflare 2019: a single regex caused a global outage.
 *   - StackExchange 2016: site offline 34 minutes from a similar regex.
 *
 * Pedagogical novelty:
 *   - No external chaos. No kumo rules active. The bug is one line
 *     of source code.
 *   - The CPU profile is the giveaway. node --inspect or
 *     /__cpu would show the regex frame.
 *   - Mitigation is targeted: rewrite the regex (no nested
 *     quantifiers) OR validate input length first OR use RE2.
 *
 * Correct mitigations:
 *   1. Rewrite the regex to remove the (a+)+ structure
 *      (catastrophic backtracking).
 *   2. Cap input length BEFORE running the regex.
 *   3. Move validation off the customer path entirely.
 *
 * Wrong directions:
 *   - Add SDK retries (doesn't help; the time is spent in regex).
 *   - Restart only (CPU pinning will resume on next bad input).
 *   - Look at kumo / DDB / pool (irrelevant).
 *   - Bump pool size (the bottleneck is event loop, not pool).
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

const ddb = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
const doc = DynamoDBDocumentClient.from(ddb);
attachTracePropagation(ddb);

// INTENTIONAL WEAKNESS: catastrophic-backtracking regex on the
// request body's `note` field. The (a+)+ structure with a $
// anchor backtracks exponentially when the input is all 'a' chars
// without the required trailing '!'. Inputs of length ~28+ pin
// the CPU for seconds.
//
// Someone wrote this as input "validation" for a note field —
// "the note must be all 'a' followed by '!'", probably as a joke
// or a placeholder that shipped. Easy to miss in code review
// because the pathological input is rare in normal traffic.
// MITIGATION (ReDoS): the original regex /^(a+)+!$/ exhibits
// catastrophic backtracking on long strings of 'a' without the
// trailing '!'. Replaced with a linear-time regex (single
// quantifier, no nesting) and bounded by an explicit length cap
// applied BEFORE matching. This is a safe equivalent: the
// language accepted is identical (one-or-more 'a' followed by '!').
const NOTE_MAX_LEN = 256;
const NOTE_VALIDATION_REGEX = /^a+!$/;

const app = new Hono();
app.use("*", honoTraceContext);

async function writeOrder(note: string): Promise<{ id: string }> {
  // Validate note before persisting — runs the catastrophic regex
  // synchronously on the customer path, blocking the event loop
  // for the duration of the backtracking.
  const ok = note.length <= NOTE_MAX_LEN && NOTE_VALIDATION_REGEX.test(note);
  if (!ok && note.length > 0) {
    // Note isn't strictly required; a malformed note just gets
    // dropped. But the regex still runs synchronously to decide.
  }
  const id = randomUUID();
  await doc.send(
    new PutCommand({ TableName: TABLE, Item: { id, ts: Date.now(), amount: 1, note: ok ? note : "" } }),
  );
  return { id };
}

app.post("/health", async (c) => {
  try {
    const out = await writeOrder("");
    return c.json({ ok: true, ...out });
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 503);
  }
});

app.post("/orders", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { note?: string };
  try {
    const out = await writeOrder(typeof body.note === "string" ? body.note : "");
    return c.json({ ...out, echo: body });
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 503);
  }
});

app.get("/verify/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const res = await doc.send(new GetCommand({ TableName: TABLE, Key: { id } }));
    if (!res.Item) return c.json({ error: "not found", id }, 404);
    return c.json(res.Item);
  } catch (err) {
    return c.json({ error: String(err) }, 503);
  }
});

// CPU profile for the agent's debugging surface — synchronous
// sample of event loop blocking. The agent runs this several
// times under normal vs adversarial traffic and sees the spike.
app.get("/__cpu", async (c) => {
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    await new Promise((r) => setImmediate(r));
    const t1 = performance.now();
    samples.push(t1 - t0);
  }
  const max = Math.max(...samples);
  const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
  return c.json({
    eventLoopDelayMs: { samples, mean, max },
    hint: max > 100 ? "event loop is blocked — something is CPU-bound" : "event loop healthy",
  });
});

mountUI(app);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.error(
    `target (regex-dos) listening on http://localhost:${info.port}. ` +
      `note validation runs a catastrophic-backtracking regex on the customer path. /__cpu for event-loop observability.`,
  );
});
