/**
 * Hono adapter for @mizchi/server-faults.
 *
 * Hono already exposes `c.req.raw` (a Web Standard Request), so the adapter
 * is a one-liner around `serverFaults({...}).maybeInject(c.req.raw)` plus
 * the customary `next()` plumbing.
 */

import { serverFaults, type ServerFaultConfig } from "../server-faults.js";

// Loosely-typed Hono surface — we intentionally avoid importing from "hono"
// so server-faults stays zero-dep. Consumers compile against their own Hono.
interface HonoLikeContext {
  req: { raw: Request };
}
interface HonoLikeNext {
  (): Promise<unknown>;
}
type HonoLikeMiddleware = (c: HonoLikeContext, next: HonoLikeNext) => Promise<Response | undefined | void>;

export function honoMiddleware(cfg: ServerFaultConfig): HonoLikeMiddleware {
  const fault = serverFaults(cfg);
  return async (c, next) => {
    const response = await fault.maybeInject(c.req.raw);
    if (response) return response;
    await next();
  };
}
