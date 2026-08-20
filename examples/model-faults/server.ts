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

  app.get("/", (c) => {
    const html = readFileSync(join(publicDir, "index.html"), "utf8").replace(
      "<script src=\"/app.js\"></script>",
      `<script>window.__CHECKOUT_FIXED__ = ${fixed ? "true" : "false"};</script>\n    <script src="/app.js"></script>`,
    );
    return c.html(html);
  });

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
