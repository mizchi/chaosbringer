/**
 * Target variant for the dns-storm scenario (#119 Gap 3 network layer).
 *
 * Talks to DynamoDB via kumo, but ROUTES the SDK through a TCP
 * chaos proxy (scripts/tcp-chaos-proxy.ts) running between the
 * target and kumo. The proxy's `connect-refuse` rule simulates an
 * intermittent DNS storm / cross-AZ partition: some fraction of
 * new TCP connections get destroyed before they reach kumo, so
 * the SDK sees ECONNREFUSED / socket hangup at connect time.
 *
 * Distinct from prior connection-level scenarios:
 *   - ddb-dns-race: kumo's `disconnect` inject — connection
 *     established to kumo then torn down. Server-side state may
 *     have changed.
 *   - network-rst-idempotency: kumo's `disconnect` with afterMs
 *     — connection established, request body received, then RST.
 *   - dns-storm (this): connection NEVER reaches kumo. No
 *     server-side state is touched. Pure pre-connect failure.
 *
 * At startup this variant installs its TCP chaos rule via the proxy
 * admin endpoint; the proxy is expected to already be running on
 * :14566 / :14567 (started by the harness, or manually for
 * development). If the install fails, the target still boots — the
 * agent then sees a healthy proxy with no chaos, which is the
 * "scenario not set up" condition.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { Agent } from "node:http";
import { randomUUID } from "node:crypto";
import { attachTracePropagation, honoTraceContext } from "@mizchi/aws-faults";
import { mountUI } from "./ui.ts";

// Route the SDK through the TCP chaos proxy (default :14566) instead
// of straight to kumo (:4566). The proxy will forward to kumo when
// it isn't actively dropping connections.
const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:14566";
const TABLE = process.env.ORDERS_TABLE ?? "orders";

const ddb = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  // INTENTIONAL: disable SDK-level retries so connect-refuse blips
  // surface as customer errors. With default retries (3 attempts +
  // exponential backoff), the SDK absorbs most flapping — which
  // hides the bug. Real production sees this when retry budgets
  // are wrong, OR when the flapping persists past the retry window.
  maxAttempts: 1,
  // Force a fresh TCP connection per request so connect-refuse
  // chaos has a chance to fire — pooled SDK sockets would reuse
  // an already-established connection and miss the chaos.
  requestHandler: new NodeHttpHandler({
    httpAgent: new Agent({ keepAlive: false }),
  }),
});
const doc = DynamoDBDocumentClient.from(ddb);
attachTracePropagation(ddb);

// Install the TCP chaos rule at startup. Fire-and-forget — if the
// proxy isn't running, the install fails but the target still boots.
const TCP_ADMIN = process.env.TCP_ADMIN_URL ?? "http://localhost:14567";
(async () => {
  try {
    const res = await fetch(`${TCP_ADMIN}/tcp-chaos/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "dns-storm",
        enabled: true,
        inject: { kind: "connect-refuse", probability: 0.4 },
      }),
    });
    if (res.ok) {
      console.error(`[dns-storm] installed tcp-chaos rule via ${TCP_ADMIN}`);
    } else {
      console.error(`[dns-storm] tcp-chaos install failed: ${res.status}`);
    }
  } catch (err) {
    console.error(`[dns-storm] tcp-chaos proxy unreachable: ${err} — scenario will read clean`);
  }
})();

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
    `target (dns-storm) listening on http://localhost:${info.port}. ` +
      `Routing AWS SDK through TCP chaos proxy at ${ENDPOINT}.`,
  );
});
