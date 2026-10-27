/**
 * Serves one variant of a pattern on an ephemeral port. Each run gets its own
 * server, so nothing a page did in one run (a stored value, a cached
 * response) reaches the next.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DataPattern, RouteContext, Routes, Variant } from "./pattern.js";

export interface PatternServer {
  origin: string;
  close(): Promise<void>;
}

export interface VariantServer extends PatternServer {
  /** What the routes were built with; the query channel builds its URL from it too. */
  ctx: RouteContext;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `host` is the host name in the returned origin; the server always listens
 * on 127.0.0.1, which `localhost` also reaches.
 */
export async function serveRoutes(routes: Routes, host = "127.0.0.1"): Promise<PatternServer> {
  const server: Server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const route = routes[path];
    try {
      if (!route) {
        res.writeHead(path === "/favicon.ico" ? 204 : 404, { "content-type": "text/plain" });
        res.end(path === "/favicon.ico" ? "" : "not found");
        return;
      }
      switch (route.type) {
        case "html":
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(route.body);
          return;
        case "json":
          if (route.delayMs) await sleep(route.delayMs);
          res.writeHead(route.status ?? 200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(route.body));
          return;
        case "raw":
          res.writeHead(route.status, { "content-type": route.contentType, "cache-control": "no-store" });
          res.end(route.body);
          return;
        case "handler":
          await route.handle(req, res);
          return;
      }
    } catch (err) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://${host}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * Serve one variant. With `thirdPartyRoutes`, those go on a second server
 * reached as `localhost`: a different origin from the app's `127.0.0.1`, so
 * the crawler treats a navigation there as leaving the site. `routes`
 * replaces the pattern's own (scan-check serves the bad data this way).
 */
export async function servePattern(
  pattern: DataPattern,
  variant: Variant,
  routes: (variant: Variant, ctx: RouteContext) => Routes = (v, c) => pattern.routes(v, c),
): Promise<VariantServer> {
  const third = pattern.thirdPartyRoutes ? await serveRoutes(pattern.thirdPartyRoutes(variant), "localhost") : null;
  const ctx: RouteContext = { thirdPartyOrigin: third?.origin ?? "" };
  try {
    const app = await serveRoutes(routes(variant, ctx));
    return {
      origin: app.origin,
      ctx,
      close: async () => {
        await app.close();
        await third?.close();
      },
    };
  } catch (err) {
    await third?.close();
    throw err;
  }
}
