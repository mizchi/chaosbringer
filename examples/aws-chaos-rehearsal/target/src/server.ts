/**
 * Target app: minimal Hono service backed by DynamoDB-via-kumo.
 * Hardened during incident: cap SDK retries, short request timeout,
 * decouple /health probe from live DDB writes via a tiny circuit breaker.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { randomUUID } from "node:crypto";

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const TABLE = process.env.ORDERS_TABLE ?? "orders";

// MITIGATION: cap retries to 1 (no exponential blowup), short socket/connect
// timeouts so a hung DDB call cannot tie up the event loop for 5s.
const client = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  maxAttempts: 1,
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 300,
    socketTimeout: 400,
  }),
});
const doc = DynamoDBDocumentClient.from(client);

const app = new Hono();

// Simple circuit breaker state.
let consecutiveFailures = 0;
let openUntil = 0;
const FAIL_THRESHOLD = 3;
const OPEN_MS = 1500;
const HALF_OPEN_PROB = 0.1;

function breakerAllow(): boolean {
  const now = Date.now();
  if (now < openUntil) {
    // half-open: allow a small fraction of probes through to test recovery
    return Math.random() < HALF_OPEN_PROB;
  }
  return true;
}

function breakerOnSuccess() {
  consecutiveFailures = 0;
  openUntil = 0;
}

function breakerOnFailure() {
  consecutiveFailures++;
  if (consecutiveFailures >= FAIL_THRESHOLD) {
    openUntil = Date.now() + OPEN_MS;
  }
}

async function writeOrder(): Promise<{ id: string }> {
  const id = randomUUID();
  await doc.send(
    new PutCommand({
      TableName: TABLE,
      Item: { id, ts: Date.now(), amount: 1 },
    }),
  );
  return { id };
}

// Best-effort write with a hard per-request deadline; never throws.
async function tryWriteOrder(deadlineMs: number): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!breakerAllow()) {
    return { ok: false, error: "circuit-open" };
  }
  try {
    const res = await Promise.race<Promise<{ id: string }> | Promise<never>>([
      writeOrder(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("deadline")), deadlineMs)),
    ]);
    breakerOnSuccess();
    return { ok: true, id: res.id };
  } catch (err) {
    breakerOnFailure();
    return { ok: false, error: String(err) };
  }
}

// /health: shed load. Always 200 if process is alive. Opportunistically try
// a write but never fail the probe on DDB chaos.
app.post("/health", async (c) => {
  const out = await tryWriteOrder(500);
  return c.json({ ok: true, write: out });
});

app.post("/orders", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const out = await tryWriteOrder(800);
  if (!out.ok) return c.json({ ok: false, error: out.error }, 503);
  return c.json({ id: out.id, echo: body });
});

app.get("/", (c) => c.text("target up"));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.error(`target listening on http://localhost:${info.port} -> kumo at ${ENDPOINT}`);
});
