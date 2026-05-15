/**
 * Koa adapter for @mizchi/server-faults.
 *
 * `ctx.req` is the underlying Node request. We translate it into a Web
 * Standard `Request` for `serverFaults()`, then write the synthetic
 * response back through `ctx.status` / `ctx.body`.
 */

import {
  assertAdapterSupportsConfig,
  attrsToHeaderEntries,
  resolveMetadataPrefix,
  serverFaults,
  type ServerFaultConfig,
} from "../server-faults.js";

interface KoaLikeSocket {
  destroy(err?: Error): void;
  end?: () => void;
}
interface KoaLikeRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: KoaLikeSocket;
}
interface KoaLikeContext {
  req: KoaLikeRequest;
  status: number;
  body: unknown;
  set(field: string, val: string): void;
}
type KoaLikeNext = () => Promise<unknown>;

function toWebRequest(req: KoaLikeRequest): Request {
  const host = (req.headers.host as string | undefined) ?? "localhost";
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) headers.append(k, item);
    } else {
      headers.set(k, v);
    }
  }
  return new Request(`http://${host}${req.url ?? "/"}`, {
    method: req.method ?? "GET",
    headers,
  });
}

export function koaMiddleware(
  cfg: ServerFaultConfig,
): (ctx: KoaLikeContext, next: KoaLikeNext) => Promise<void> {
  assertAdapterSupportsConfig(cfg, "koa");
  const fault = serverFaults(cfg);
  const metadataPrefix = resolveMetadataPrefix(cfg.metadataHeader);
  return async (ctx, next) => {
    const verdict = await fault.maybeInject(toWebRequest(ctx.req));
    if (!verdict) {
      await next();
      return;
    }
    if (verdict.kind === "synthetic") {
      ctx.status = verdict.response.status;
      verdict.response.headers.forEach((value, key) => {
        ctx.set(key, value);
      });
      ctx.body = await verdict.response.json();
      return;
    }
    if (verdict.kind === "abort") {
      // See express adapter — same socket-level teardown contract. Koa's
      // ctx.req is the raw Node IncomingMessage, so `req.socket` is the same
      // object as in the Express case.
      const socket = ctx.req.socket;
      if (verdict.abortStyle === "reset") {
        socket?.destroy(new Error("server-faults: synthetic abort"));
      } else if (socket?.end) {
        socket.end();
      } else {
        socket?.destroy();
      }
      return;
    }
    if (verdict.kind === "partial" || verdict.kind === "slowStream") {
      // Unreachable: assertAdapterSupportsConfig() refuses construction
      // when these are enabled. Kept so exhaustive narrowing catches
      // any future verdict additions at compile time.
      throw new Error(`server-faults: unexpected ${verdict.kind} verdict on koa adapter`);
    }
    if (verdict.kind === "annotate") {
      // Stamp BEFORE next() — Koa's ctx.set just wraps res.setHeader, which
      // buffers headers until the response is flushed. A downstream handler
      // that bypasses ctx (writing to ctx.res directly) would skip these
      // headers; that is the documented escape hatch.
      if (metadataPrefix) {
        for (const [name, value] of attrsToHeaderEntries(verdict.attrs, metadataPrefix)) {
          ctx.set(name, value);
        }
      }
      await next();
      return;
    }
    const _exhaustive: never = verdict;
    void _exhaustive;
  };
}
