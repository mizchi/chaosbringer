/**
 * Fastify adapter for @mizchi/server-faults.
 *
 * Returns a Fastify plugin that registers an `onRequest` hook. The hook
 * decides early — before any handler — whether to short-circuit with a
 * synthetic 5xx (or sleep for latency) and let normal flow continue.
 */

import {
  assertAdapterSupportsConfig,
  attrsToHeaderEntries,
  resolveMetadataPrefix,
  serverFaults,
  type ServerFaultConfig,
} from "../server-faults.js";

interface FastifyLikeSocket {
  destroy(err?: Error): void;
  end?: () => void;
}
interface FastifyLikeRequest {
  method: string;
  url: string;
  hostname?: string;
  headers: Record<string, string | string[] | undefined>;
  /** Underlying Node IncomingMessage; carries `.socket` for teardown. */
  raw?: { socket?: FastifyLikeSocket };
  socket?: FastifyLikeSocket;
}
interface FastifyLikeReply {
  code(statusCode: number): FastifyLikeReply;
  header(name: string, value: string): FastifyLikeReply;
  send(payload: unknown): unknown;
}
interface FastifyLikeInstance {
  addHook(
    name: "onRequest",
    handler: (req: FastifyLikeRequest, reply: FastifyLikeReply) => Promise<void>,
  ): void;
}

function toWebRequest(req: FastifyLikeRequest): Request {
  const host = (req.headers.host as string | undefined) ?? req.hostname ?? "localhost";
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) headers.append(k, item);
    } else {
      headers.set(k, v);
    }
  }
  return new Request(`http://${host}${req.url}`, {
    method: req.method,
    headers,
  });
}

export function fastifyPlugin(cfg: ServerFaultConfig) {
  assertAdapterSupportsConfig(cfg, "fastify");
  const fault = serverFaults(cfg);
  const metadataPrefix = resolveMetadataPrefix(cfg.metadataHeader);
  return async function plugin(fastify: FastifyLikeInstance) {
    fastify.addHook("onRequest", async (req, reply) => {
      const verdict = await fault.maybeInject(toWebRequest(req));
      if (!verdict) return;
      if (verdict.kind === "synthetic") {
        reply.code(verdict.response.status);
        verdict.response.headers.forEach((value, key) => {
          reply.header(key, value);
        });
        await reply.send(await verdict.response.json());
        return;
      }
      if (verdict.kind === "abort") {
        // Prefer req.raw.socket (the canonical Fastify accessor for the
        // underlying Node socket); fall back to req.socket which newer
        // Fastify versions also expose. Reset uses destroy(err); hangup
        // half-closes via end() and falls back to destroy() if absent.
        const socket = req.raw?.socket ?? req.socket;
        if (verdict.abortStyle === "reset") {
          socket?.destroy(new Error("server-faults: synthetic abort"));
        } else if (socket?.end) {
          socket.end();
        } else {
          socket?.destroy();
        }
        return;
      }
      if (verdict.kind === "partial") {
        // Unreachable: assertAdapterSupportsConfig() refuses construction
        // when partialResponseRate > 0. Kept so exhaustive narrowing
        // catches any future verdict additions at compile time.
        throw new Error("server-faults: unexpected partial verdict on fastify adapter");
      }
      if (verdict.kind === "annotate") {
        // Stamp headers; the real route runs after this hook returns. If a
        // downstream handler later returns a Response with frozen headers,
        // any subsequent `reply.header(...)` would throw — that is the
        // documented contract.
        if (metadataPrefix) {
          for (const [name, value] of attrsToHeaderEntries(verdict.attrs, metadataPrefix)) {
            reply.header(name, value);
          }
        }
        return;
      }
      const _exhaustive: never = verdict;
      void _exhaustive;
    });
  };
}
