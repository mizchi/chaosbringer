/**
 * Target variant for the multi-service cascade scenario (#119 Gap 2).
 *
 * Three Hono services in one process, on adjacent ports — the
 * minimum viable shape for a "cascade across service boundaries"
 * test. From the agent's view this is a real multi-service system
 * (separate endpoints, separate code paths, separate SDK clients);
 * it just happens to live in a single tsx process so the smoke test
 * doesn't need to coordinate three child processes.
 *
 * Topology:
 *
 *   customer -> :3000 OrderCoordinator
 *                 |--> :3001 PaymentService  --(DDB PutItem)--> kumo
 *                 \--> :3002 NotificationService  --(Kinesis PutRecord)--> kumo
 *
 * Order calls Payment SYNCHRONOUSLY (the customer must see the
 * charge result), then fire-and-forgets Notification. If Payment is
 * slow / failing, the customer-visible /orders endpoint is the
 * symptom — but the bug lives in Payment's AWS call path.
 *
 * Variant-specific anti-patterns the cascade scenario detects:
 *   - Mitigating IN OrderCoordinator (e.g. adding a circuit breaker
 *     around the Payment call) instead of in Payment itself
 *   - Increasing Payment's SDK retries (which compounds DDB
 *     latency pressure)
 *   - Removing Notification from the path on the assumption that
 *     it's the source (it's not; the cascade is Payment-driven)
 *
 * Each service has its own /verify/:id endpoint, and the
 * OrderCoordinator's /verify/:id verifies the charge exists in
 * Payment before returning 200 — so the journey-based customer probe
 * naturally exposes the cascade.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { KinesisClient, PutRecordCommand } from "@aws-sdk/client-kinesis";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { randomUUID } from "node:crypto";
import { attachTracePropagation, honoTraceContext } from "@mizchi/aws-faults";
import { mountUI } from "./ui.ts";

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const CHARGES_TABLE = "charges";
const EVENTS_STREAM = "events";

const PAYMENT_URL = "http://localhost:3001";
const NOTIFICATION_URL = "http://localhost:3002";

// -------- PaymentService (port 3001) --------

const paymentDdb = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
const paymentDoc = DynamoDBDocumentClient.from(paymentDdb);
attachTracePropagation(paymentDdb);

const paymentApp = new Hono();
paymentApp.use("*", honoTraceContext);

paymentApp.post("/charge", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { orderId?: string };
  const id = body.orderId ?? randomUUID();
  try {
    // The customer's charge MUST land in DDB. Any failure here means
    // the order didn't actually go through.
    await paymentDoc.send(
      new PutCommand({ TableName: CHARGES_TABLE, Item: { id, ts: Date.now(), amount: 1 } }),
    );
    return c.json({ id, charged: true });
  } catch (err) {
    return c.json({ id, charged: false, error: String(err) }, 503);
  }
});

paymentApp.get("/verify/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const res = await paymentDoc.send(new GetCommand({ TableName: CHARGES_TABLE, Key: { id } }));
    if (!res.Item) return c.json({ error: "charge missing", id }, 404);
    return c.json(res.Item);
  } catch (err) {
    return c.json({ error: String(err) }, 503);
  }
});

paymentApp.get("/", (c) => c.text("payment up"));

// -------- NotificationService (port 3002) --------

const notifyKinesis = new KinesisClient({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
  requestHandler: new NodeHttpHandler(),
});
attachTracePropagation(notifyKinesis);

const notificationApp = new Hono();
notificationApp.use("*", honoTraceContext);

notificationApp.post("/notify", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { orderId?: string };
  const id = body.orderId ?? randomUUID();
  try {
    await notifyKinesis.send(
      new PutRecordCommand({
        StreamName: EVENTS_STREAM,
        Data: new TextEncoder().encode(JSON.stringify({ id, ts: Date.now() })),
        PartitionKey: id,
      }),
    );
    return c.json({ id, notified: true });
  } catch (err) {
    return c.json({ id, notified: false, error: String(err) }, 503);
  }
});

notificationApp.get("/", (c) => c.text("notification up"));

// -------- OrderCoordinator (port 3000, customer-facing) --------

const orderApp = new Hono();
orderApp.use("*", honoTraceContext);

async function placeOrder(traceHeader: string): Promise<{ id: string }> {
  const id = randomUUID();
  // 1. Charge SYNCHRONOUSLY via PaymentService. If this fails, the
  //    whole order fails — the customer must not see "success" if
  //    they weren't charged.
  // INTENTIONAL: OrderCoordinator's call to Payment uses a 600ms
  // timeout that doesn't account for Payment's tail latency. Under
  // chaos (latency p95=1200ms), the slow tail trips this
  // client-side and surfaces as 503 on /orders even though Payment
  // would have responded a moment later. The cascade is on the
  // Payment->DDB path, but it surfaces here because Order->Payment
  // is the synchronous customer-visible link.
  const chargeRes = await fetch(`${PAYMENT_URL}/charge`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(traceHeader ? { traceparent: traceHeader } : {}) },
    body: JSON.stringify({ orderId: id }),
    signal: AbortSignal.timeout(600),
  });
  if (!chargeRes.ok) {
    throw new Error(`payment failed: ${chargeRes.status}`);
  }
  // 2. Fire-and-forget the notification — non-critical for the
  //    customer success path. (A real system would put this in a
  //    queue; we model it as a best-effort fetch with no await on
  //    the result body.)
  fetch(`${NOTIFICATION_URL}/notify`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(traceHeader ? { traceparent: traceHeader } : {}) },
    body: JSON.stringify({ orderId: id }),
    signal: AbortSignal.timeout(2_000),
  }).catch(() => {});
  return { id };
}

orderApp.post("/health", async (c) => {
  try {
    const trace = c.req.header("traceparent") ?? "";
    const out = await placeOrder(trace);
    return c.json({ ok: true, ...out });
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 503);
  }
});

orderApp.post("/orders", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const trace = c.req.header("traceparent") ?? "";
    const out = await placeOrder(trace);
    return c.json({ ...out, echo: body });
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 503);
  }
});

orderApp.get("/verify/:id", async (c) => {
  const id = c.req.param("id");
  try {
    // The customer-visible invariant: the charge actually landed in
    // PaymentService's store. If Payment was slow/failing and the
    // wrong-direction mitigation made /orders return 200 without
    // waiting for the charge, this catches it.
    const r = await fetch(`${PAYMENT_URL}/verify/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (r.status === 404) return c.json({ error: "charge missing", id }, 404);
    if (!r.ok) return c.json({ error: "payment verify failed", status: r.status, id }, 503);
    return c.json(await r.json());
  } catch (err) {
    return c.json({ error: String(err) }, 503);
  }
});

mountUI(orderApp);

// -------- Boot all three --------

const orderPort = Number(process.env.PORT ?? 3000);
const paymentPort = Number(process.env.PAYMENT_PORT ?? 3001);
const notificationPort = Number(process.env.NOTIFICATION_PORT ?? 3002);

serve({ fetch: paymentApp.fetch, port: paymentPort }, (info) => {
  console.error(`PaymentService listening on http://localhost:${info.port}`);
});
serve({ fetch: notificationApp.fetch, port: notificationPort }, (info) => {
  console.error(`NotificationService listening on http://localhost:${info.port}`);
});
serve({ fetch: orderApp.fetch, port: orderPort }, (info) => {
  console.error(`OrderCoordinator listening on http://localhost:${info.port}`);
});
