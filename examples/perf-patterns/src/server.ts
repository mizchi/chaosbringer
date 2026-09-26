/**
 * Serves one variant of a pattern on an ephemeral port. Each variant gets its
 * own server with the same paths, so the perfKeys (which drop the origin) are
 * identical between `slow` and `fixed` and can be compared key by key.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Pattern, Routes, Variant } from "./pattern.js";

export interface PatternServer {
  origin: string;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function serveRoutes(routes: Routes): Promise<PatternServer> {
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
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function servePattern(pattern: Pattern, variant: Variant): Promise<PatternServer> {
  return serveRoutes(pattern.routes(variant));
}
