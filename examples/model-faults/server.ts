/**
 * Checkout app under test. Hono + @hono/node-server, two endpoints and one
 * page — small enough to read in a minute, real enough to carry the async
 * patterns that break in production.
 *
 * `FIXED=1` serves the corrected client (see public/app.js for the two
 * seeded bugs). Same code path either way; the flag is handed to the browser
 * as `window.__CHECKOUT_FIXED__`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "public");

export interface StartedServer {
  url: string;
  close: () => Promise<void>;
}

export function createApp(fixed: boolean): Hono {
  const app = new Hono();

  /**
   * Serve a page with its variant flag and a fresh session id injected.
   *
   * The session id scopes server-side state to one page load, so plans that
   * assert on write counts cannot see each other's writes — every plan gets
   * its own browser, and now its own server-side slate too.
   */
  function pageWithFlags(file: string, isFixed: boolean): string {
    const html = readFileSync(join(publicDir, file), "utf8");
    const session = `s-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    const flags =
      `<script>window.__CHECKOUT_FIXED__ = ${isFixed ? "true" : "false"};` +
      `window.__ORDER_FIXED__ = ${isFixed ? "true" : "false"};` +
      `window.__SESSION__ = ${JSON.stringify(session)};</script>`;
    return html.replace(/<script src="\/([\w.-]+)"><\/script>/, `${flags}\n    <script src="/$1"></script>`);
  }

  app.get("/", (c) => c.html(pageWithFlags("index.html", fixed)));

  app.get("/app.js", (c) => {
    c.header("content-type", "text/javascript; charset=utf-8");
    return c.body(readFileSync(join(publicDir, "app.js"), "utf8"));
  });

  app.get("/api/cart", (c) =>
    c.json({
      items: [
        { sku: "CB-001", name: "Chaos hoodie", qty: 1, price: 68 },
        { sku: "CB-014", name: "Sticker pack", qty: 2, price: 6 },
      ],
      total: 80,
    }),
  );

  app.get("/api/shipping", (c) =>
    c.json({ carrier: "Yamato", eta: "2026-08-24", cost: 5 }),
  );

  // --- retry / idempotency pattern -------------------------------------
  //
  // Orders are keyed by session so concurrent plan runs cannot see each
  // other's writes, and deduped by Idempotency-Key the way a real payment
  // API would be. `writes` counts *distinct* orders, which is what the model
  // asserts on: one user intent must produce one order however many times the
  // client retries.
  const orders = new Map<string, Map<string, string>>();

  app.get("/retry", (c) => c.html(pageWithFlags("retry.html", fixed)));
  app.get("/retry.js", (c) => {
    c.header("content-type", "text/javascript; charset=utf-8");
    return c.body(readFileSync(join(publicDir, "retry.js"), "utf8"));
  });

  app.post("/api/order", async (c) => {
    const session = c.req.header("x-session") ?? "anonymous";
    const key = c.req.header("idempotency-key");
    const perSession = orders.get(session) ?? new Map<string, string>();
    orders.set(session, perSession);
    if (key && perSession.has(key)) {
      // Replay of a write we already committed: same id, no second order.
      return c.json({ id: perSession.get(key), deduped: true });
    }
    const id = `ord-${perSession.size + 1}`;
    perSession.set(key ?? id, id);
    return c.json({ id, deduped: false });
  });

  app.get("/api/orders/count", (c) => {
    const session = c.req.query("session") ?? "anonymous";
    return c.json({ orders: orders.get(session)?.size ?? 0 });
  });

  return app;
}

/** Boot on `port` (0 = ephemeral). Used by run.ts and the test. */
export function startServer(port = 0, fixed = process.env.FIXED === "1"): Promise<StartedServer> {
  return new Promise((resolve) => {
    const server = serve({ fetch: createApp(fixed).fetch, port }, (info) => {
      resolve({
        url: `http://127.0.0.1:${info.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// `tsx server.ts` runs it standalone for manual poking.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number.parseInt(process.env.PORT ?? "5173", 10);
  const { url } = await startServer(port);
  console.log(`checkout app (${process.env.FIXED === "1" ? "fixed" : "buggy"}) on ${url}`);
}
