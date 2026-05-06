/**
 * Koa adapter for @mizchi/server-faults.
 *
 * `ctx.req` is the underlying Node request. We translate it into a Web
 * Standard `Request` for `serverFaults()`, then write the synthetic
 * response back through `ctx.status` / `ctx.body`.
 */

import { serverFaults, type ServerFaultConfig } from "../server-faults.js";

interface KoaLikeRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
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
  const fault = serverFaults(cfg);
  return async (ctx, next) => {
    const response = await fault.maybeInject(toWebRequest(ctx.req));
    if (!response) return next().then(() => undefined);
    ctx.status = response.status;
    response.headers.forEach((value, key) => {
      ctx.set(key, value);
    });
    ctx.body = await response.json();
  };
}
