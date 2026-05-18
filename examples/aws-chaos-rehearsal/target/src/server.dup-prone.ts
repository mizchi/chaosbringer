/**
 * BUGGY baseline for the idempotency-violation hard scenario (Tier 6).
 *
 * Demonstrates a state-correctness bug that is INVISIBLE to a customer
 * SLO probe. /orders returns 200 with a fresh ID; the customer sees
 * exactly one charge. But in DynamoDB, retried-and-timed-out attempts
 * have ALSO persisted ghost rows. The accounting team eventually
 * notices double-billing.
 *
 * The bug:
 *
 *   async function writeOrder() {
 *     for (let attempt = 0; attempt < 5; attempt++) {
 *       const id = randomUUID();  // <-- BUG: new id per attempt
 *       try {
 *         await doc.send(new PutCommand({ Item: { id, ... } }));
 *         return { id };  // returned-to-customer id
 *       } catch (err) {
 *         if (!retryable) throw;
 *       }
 *     }
 *   }
 *
 * Under latency-induced TimeoutError:
 *   - Attempt 1: client times out at 800ms. SDK throws TimeoutError.
 *     Kumo's handler (running with 1500ms sleep) STILL completes the
 *     PutItem afterward. Ghost row id1 lands in DDB.
 *   - Attempt 2 (new id): succeeds. Customer sees id2.
 *   - DDB has id1 + id2 for one customer request.
 *
 * /dup-check exposes the ghost count: sent_ids - returned_ids.
 * It's not visible from /orders or /health alone.
 *
 * The fix: move randomUUID() OUT of the retry loop. One id per
 * writeOrder; retries use the same body; SDK or app retry safely
 * idempotent on DDB.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { randomUUID } from "node:crypto";

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const TABLE = process.env.ORDERS_TABLE ?? "orders";

// Tight socket timeout: 800ms. Combined with chaos latency p99=2s, ~30%
// of requests will exceed and throw TimeoutError client-side while the
// PutItem completes server-side.
const ddb = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  maxAttempts: 1, // disable SDK internal retry so app-level retry fires
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 200,
    socketTimeout: 800,
  }),
});
const doc = DynamoDBDocumentClient.from(ddb);

// Telemetry for /dup-check.
const sentIds = new Set<string>();
const returnedIds = new Set<string>();

const app = new Hono();

async function writeOrder(): Promise<{ id: string }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = randomUUID(); // BUG: new id per attempt (idempotency violation)
    sentIds.add(id);
    try {
      await doc.send(
        new PutCommand({
          TableName: TABLE,
          Item: { id, ts: Date.now(), amount: 1 },
        }),
      );
      returnedIds.add(id);
      return { id };
    } catch (err) {
      lastErr = err;
      const msg = String(err);
      if (!/TimeoutError|ECONNRESET|Throttl|ServiceUnavailable/i.test(msg)) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 50 * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
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

// State-correctness probe. Returns counts of unique ids the target
// SENT vs RETURNED. Ghosts = sent - returned: attempts that left the
// process but were not acknowledged to the customer. Each ghost is
// potentially a duplicate row in DDB.
app.get("/dup-check", (c) => {
  const ghosts = [...sentIds].filter((id) => !returnedIds.has(id));
  return c.json({
    sent: sentIds.size,
    returned: returnedIds.size,
    ghosts: ghosts.length,
    sampleGhosts: ghosts.slice(0, 5),
  });
});

app.get("/", (c) => c.text("target up (dup-prone)"));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.error(
    `target (dup-prone) listening on http://localhost:${info.port}. ` +
      `/dup-check endpoint exposes state-correctness telemetry.`,
  );
});
