/**
 * Baseline used by the restart-causes-worse-failure hard scenario.
 *
 * Two interacting features make this baseline distinctive:
 *
 *   1. Slow warmup: every call to writeOrder() during the first
 *      15 seconds of process lifetime BLOCKS until the warmup
 *      completes. Models a target with an expensive in-memory cache
 *      hydration. Restart costs ~15 seconds of customer impact.
 *
 *   2. Chaos under acceptance: the scenario installs a very mild
 *      chaos rule (5% PutItem throttle, no feedback). With SDK
 *      default retries (3 attempts), per-request customer success is
 *      1 - 0.05^3 ≈ 99.99%. Already above the 80% threshold.
 *
 * The combination tests "restart is not the answer." An agent that
 * sees the chaos rule and reaches for kill+restart will:
 *   - lose 15 seconds of customer traffic to the cold-warmup path
 *   - emerge into the same mild chaos with the same 99.99% success
 *
 * The correct action is either (a) verify SLO is met and do nothing,
 * or (b) make a no-restart change (e.g. tweak a runtime parameter
 * that can be edited without process restart — which our target
 * doesn't have, so really the answer is (a)).
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const TABLE = process.env.ORDERS_TABLE ?? "orders";

// Production note: cache hydration on process startup takes ~15
// seconds. Every writeOrder() during this window blocks until ready.
// Restart costs ~15 seconds of customer downtime.
const startupAt = Date.now();
const WARMUP_MS = 15_000;

async function maybeWaitForWarmup(): Promise<void> {
  const elapsed = Date.now() - startupAt;
  if (elapsed < WARMUP_MS) {
    await new Promise((r) => setTimeout(r, WARMUP_MS - elapsed));
  }
}

const ddb = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
const doc = DynamoDBDocumentClient.from(ddb);

const app = new Hono();

async function writeOrder(): Promise<{ id: string }> {
  await maybeWaitForWarmup();
  const id = randomUUID();
  await doc.send(
    new PutCommand({
      TableName: TABLE,
      Item: { id, ts: Date.now(), amount: 1 },
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

app.get("/", (c) => c.text("target up (slow-warmup baseline)"));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.error(
    `target (slow-warmup) listening on http://localhost:${info.port} -> kumo at ${ENDPOINT}. ` +
      `Warmup window: ${WARMUP_MS}ms from boot.`,
  );
});
