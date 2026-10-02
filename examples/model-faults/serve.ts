/**
 * Boot a Hono app on `port` (0 = ephemeral). The checkout app, the redteam
 * app and the patterns-audit app all start this way.
 */
import { serve } from "@hono/node-server";
import type { Hono } from "hono";

export interface StartedServer {
  url: string;
  close: () => Promise<void>;
}

export function startApp(app: Hono, port = 0): Promise<StartedServer> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port }, (info) => {
      resolve({
        url: `http://127.0.0.1:${info.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
