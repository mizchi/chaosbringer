/**
 * Target variant for the client-timeout-misconfig scenario (#119 Gap 4).
 *
 * This target's bug lives ENTIRELY in the SDK client config — kumo is
 * fine, the network is fine, no chaos is destructive. The DDB client
 * has `socketTimeout: 250ms`, which is well below typical production
 * SLA budgets but above kumo's chaos-installed baseline latency
 * (p99 ~ 400ms). Result: client-side TimeoutError on the slow tail
 * even though the upstream call eventually succeeds.
 *
 * Pedagogically novel: every prior scenario has the bug AT the
 * upstream (chaos rules express it) or in the customer-path logic
 * (variant target writes wrong data). Here:
 *   - chaos stats show ONE rule, low-impact (baseline latency)
 *   - target source has the bug (socketTimeout: 250)
 *   - mitigation is a one-line config change
 *
 * Correct path: read /kumo/chaos/stats, see baseline latency is benign;
 * read target/src/server.ts, see the tight socketTimeout; bump it.
 * Wrong paths: blame upstream, add retries (each retry trips the same
 * timeout), add a circuit breaker (band-aid).
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { randomUUID } from "node:crypto";
import { attachTracePropagation, honoTraceContext } from "@mizchi/aws-faults";
import { mountUI } from "./ui.ts";

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const TABLE = process.env.ORDERS_TABLE ?? "orders";

// INTENTIONAL WEAKNESS: socketTimeout below typical p99 latencies. Any
// upstream call slower than ~250ms throws TimeoutError client-side
// even though kumo's response would have arrived shortly after.
const ddb = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  maxAttempts: 1,
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 200,
    socketTimeout: 250, // BUG: too tight. Production should be 3-5s+.
  }),
});
const doc = DynamoDBDocumentClient.from(ddb);
attachTracePropagation(ddb);

const app = new Hono();
app.use("*", honoTraceContext);

async function writeOrder(): Promise<{ id: string }> {
  const id = randomUUID();
  await doc.send(
    new PutCommand({ TableName: TABLE, Item: { id, ts: Date.now(), amount: 1 } }),
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

mountUI(app);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.error(
    `target (tight-timeout) listening on http://localhost:${info.port}. ` +
      `socketTimeout=250ms — intentionally tight.`,
  );
});
