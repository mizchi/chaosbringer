/**
 * BUGGY baseline used by the misleading-chaos adversarial scenario.
 *
 * The customer write path includes an INTENTIONAL random throw — 40% of
 * calls fail with a synthetic "validation error." This simulates a
 * recent-deploy regression: a latent assertion / validation bug landed
 * in production while AWS is also having issues.
 *
 * The adversarial twist: kumo chaos is installed against services this
 * target DOES NOT USE (cognito-idp + lambda). Chaos stats show
 * non-zero match counts on those (from background AWS SDK pings
 * elsewhere), but they don't actually break /orders. The real fault
 * is in this file.
 *
 * Good agents read the source carefully and notice the validate()
 * throw. Bad agents see chaos stats firing and apply a chaos-style
 * mitigation (decouple X, cap retries) that doesn't fix anything.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const TABLE = process.env.ORDERS_TABLE ?? "orders";

const ddb = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
const doc = DynamoDBDocumentClient.from(ddb);

const app = new Hono();

// ⚠ Bug introduced by recent deploy: the new "validation" step throws
// on 40% of requests with no upstream involvement. Removing or fixing
// this is the actual recovery action.
function validateOrder(): void {
  if (Math.random() < 0.4) {
    throw new Error("OrderValidationError: amount must be positive");
  }
}

async function writeOrder(): Promise<{ id: string }> {
  const id = randomUUID();
  validateOrder(); // <- the actual bug
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

app.get("/", (c) => c.text("target up (buggy)"));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.error(`target (buggy) listening on http://localhost:${info.port} -> kumo at ${ENDPOINT}`);
});
