/**
 * BUGGY baseline used by the compound-incident hard scenario.
 *
 * Two independent issues active at once:
 *
 *   1. A `validatePayment()` check throws ~25% of the time with no
 *      upstream involvement. Recent-deploy regression.
 *   2. The tier-config DDB lookup is the chaos-bitten path (see
 *      cacheStampede drill — feedback throttle).
 *
 * Single-fix mitigations leave the customer below threshold:
 *   - Fix only the validate bug: customer ≈ 100% * (1 - chaos_rate)
 *     ≈ 30-50% under the cache stampede chaos. Below 80% threshold.
 *   - Fix only the cache (add TTL): customer ≈ 75% * 100%
 *     ≈ 75%. Below 80% threshold by a small margin.
 *
 * Both fixes together: customer ≈ 75% * 100% = 75%? Still below?
 *
 * Actually: 25% validate throw is independent. Even with cache,
 * 25% throw → 75% customer success. Just below 80%.
 *
 * So the test is whether the agent finds BOTH issues. The chaos
 * stats reveal one; the source reveals the other. An agent who
 * stops after fixing one will be at 75%, just below the bar.
 *
 * Designed to expose Tier 4 capability boundary: multi-cause
 * diagnosis under time pressure.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

const ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";
const TABLE = process.env.ORDERS_TABLE ?? "orders";
const TIER_TABLE = process.env.TIER_TABLE ?? "tier-config";

const ddb = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});
const doc = DynamoDBDocumentClient.from(ddb);

const app = new Hono();

// Bug #1 FIXED: removed bogus PaymentValidationError throw (regression).
function validatePayment(): void {
  // intentionally no-op; previous random throw was a regression bug
}

// Bug #2 FIX: in-memory TTL cache for tier-config to avoid hammering the
// throttled DDB partition.
let tierCache: { value: unknown; expires: number } | null = null;
const TIER_TTL_MS = 30_000;

async function getTierConfig(): Promise<unknown> {
  const now = Date.now();
  if (tierCache && tierCache.expires > now) return tierCache.value;
  try {
    const res = await doc.send(
      new GetCommand({ TableName: TIER_TABLE, Key: { tenant: "default" } }),
    );
    tierCache = { value: res?.Item ?? {}, expires: now + TIER_TTL_MS };
    return tierCache.value;
  } catch (err) {
    // Serve stale on throttle; only fail closed if no prior value
    if (tierCache) return tierCache.value;
    throw err;
  }
}

async function writeOrder(): Promise<{ id: string }> {
  const id = randomUUID();
  validatePayment();
  await getTierConfig();
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

app.get("/", (c) => c.text("target up (compound-baseline)"));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.error(`target (compound) listening on http://localhost:${info.port} -> kumo at ${ENDPOINT}`);
});
