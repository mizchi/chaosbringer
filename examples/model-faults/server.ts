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
      `window.__TOKEN_FIXED__ = ${isFixed ? "true" : "false"};` +
      `window.__SLOW_FIXED__ = ${isFixed ? "true" : "false"};` +
      `window.__NOTES_FIXED__ = ${isFixed ? "true" : "false"};` +
      `window.__FEED_FIXED__ = ${isFixed ? "true" : "false"};` +
      `window.__STREAM_FIXED__ = ${isFixed ? "true" : "false"};` +
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

  // --- token-refresh pattern -------------------------------------------
  //
  // The 401s themselves are injected by a plan (that is what an expired token
  // looks like from the client's side), so the server only has to count
  // refreshes. It sleeps briefly on purpose: the refresh has to still be in
  // flight when the second 401 arrives, or there is no stampede to observe
  // and the pattern would pass for the wrong reason.
  const refreshes = new Map<string, number>();
  const REFRESH_LATENCY_MS = 80;

  app.get("/token", (c) => c.html(pageWithFlags("token.html", fixed)));
  app.get("/token.js", (c) => {
    c.header("content-type", "text/javascript; charset=utf-8");
    return c.body(readFileSync(join(publicDir, "token.js"), "utf8"));
  });

  app.get("/api/me", (c) => c.json({ name: "Ada Lovelace", id: 1 }));
  app.get("/api/prefs", (c) => c.json({ theme: "dark", locale: "en" }));

  app.post("/api/refresh", async (c) => {
    const session = c.req.header("x-session") ?? "anonymous";
    refreshes.set(session, (refreshes.get(session) ?? 0) + 1);
    await new Promise((r) => setTimeout(r, REFRESH_LATENCY_MS));
    return c.json({ token: `t-${Math.random().toString(36).slice(2)}` });
  });

  app.get("/api/refresh/count", (c) => {
    const session = c.req.query("session") ?? "anonymous";
    return c.json({ refreshes: refreshes.get(session) ?? 0 });
  });

  // --- timeout-ladder pattern ------------------------------------------
  //
  // The endpoint itself is always fast; slowness is injected by a plan, with
  // the actual millisecond values solved from this machine's calibration.
  app.get("/slow", (c) => c.html(pageWithFlags("slow.html", fixed)));
  app.get("/slow.js", (c) => {
    c.header("content-type", "text/javascript; charset=utf-8");
    return c.body(readFileSync(join(publicDir, "slow.js"), "utf8"));
  });
  app.get("/api/report", (c) => c.json({ rows: 128, generatedAt: "2026-08-20" }));

  // --- optimistic-rollback pattern -------------------------------------
  //
  // GET and POST share one URL on purpose: that is what a REST collection
  // looks like, and it is why `rules` needs a method filter — without one a
  // plan fires on whichever call arrives first. The write commits before it
  // answers, so a client that cannot read the reply has still changed the
  // server's mind: the ambiguous case the pattern exists for.
  const notes = new Map<string, Array<{ id: string; text: string }>>();

  app.get("/optimistic", (c) => c.html(pageWithFlags("optimistic.html", fixed)));
  app.get("/optimistic.js", (c) => {
    c.header("content-type", "text/javascript; charset=utf-8");
    return c.body(readFileSync(join(publicDir, "optimistic.js"), "utf8"));
  });

  app.get("/api/notes", (c) => {
    const session = c.req.query("session") ?? "anonymous";
    return c.json({ notes: notes.get(session) ?? [] });
  });

  app.post("/api/notes", async (c) => {
    const session = c.req.header("x-session") ?? "anonymous";
    const body = await c.req.json<{ text?: string }>().catch(() => ({}) as { text?: string });
    const rows = notes.get(session) ?? [];
    notes.set(session, rows);
    const id = `note-${rows.length + 1}`;
    rows.push({ id, text: body.text ?? "" });
    return c.json({ id });
  });

  app.get("/api/notes/count", (c) => {
    const session = c.req.query("session") ?? "anonymous";
    return c.json({ notes: notes.get(session)?.length ?? 0 });
  });

  // --- pagination-order pattern ----------------------------------------
  //
  // Two pages, two rows each, ascending indices. The endpoint is always fast;
  // the delay that makes page 1 lose the race to page 2 is injected by a plan
  // and solved from the app's own deadline.
  const PAGE_SIZE = 2;

  app.get("/feed", (c) => c.html(pageWithFlags("feed.html", fixed)));
  app.get("/feed.js", (c) => {
    c.header("content-type", "text/javascript; charset=utf-8");
    return c.body(readFileSync(join(publicDir, "feed.js"), "utf8"));
  });

  app.get("/api/feed", (c) => {
    const page = Number(c.req.query("page") ?? "1");
    const base = (page - 1) * PAGE_SIZE;
    return c.json({
      page,
      items: Array.from({ length: PAGE_SIZE }, (_, i) => ({
        idx: base + i + 1,
        title: `Post ${base + i + 1}`,
      })),
    });
  });

  // --- reconnect-budget pattern ----------------------------------------
  //
  // The endpoint is always healthy; the failures are injected. What the plan
  // measures is not whether the client reconnects but how many times it is
  // willing to, which is why the model states a call bound rather than a state.
  app.get("/stream", (c) => c.html(pageWithFlags("stream.html", fixed)));
  app.get("/stream.js", (c) => {
    c.header("content-type", "text/javascript; charset=utf-8");
    return c.body(readFileSync(join(publicDir, "stream.js"), "utf8"));
  });
  app.get("/api/stream", (c) => c.json({ events: 3, cursor: "c-1" }));

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
