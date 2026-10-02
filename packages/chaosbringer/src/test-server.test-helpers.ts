/**
 * A throwaway HTTP server for e2e tests: listen on a free port, hand back the
 * base URL, close it.
 *
 * `close()` drops keep-alive connections first. Without that, `server.close`
 * waits for the browser's idle sockets to time out, and a test file's
 * `afterAll` stalls for seconds (only some of the hand-written copies did
 * this).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface TestServer {
  server: http.Server;
  /** `http://<host>:<port>`, no trailing slash. */
  url: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * Start `handler` on a free port of `host`. Use `host: "localhost"` for a
 * second origin next to a `127.0.0.1` one: the browser treats them as
 * different sites.
 */
export async function startTestServer(
  handler: http.RequestListener,
  { host = "127.0.0.1" }: { host?: string } = {},
): Promise<TestServer> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    url: `http://${host}:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
