/**
 * Hono adapter for @mizchi/server-faults.
 *
 * `c.req.raw` is a Web Standard Request, so the adapter is mostly a thin
 * wrapper around `serverFaults({...}).maybeInject(req)`. The latency
 * (annotate) path requires running the real handler first and then
 * stamping the metadata headers onto `c.res.headers` afterwards.
 */

import {
  serverFaults,
  attrsToHeaderEntries,
  resolveMetadataPrefix,
  type ServerFaultConfig,
} from "../server-faults.js";

interface HonoLikeContext {
  req: { raw: Request };
  res?: { headers: Headers };
}
interface HonoLikeNext {
  (): Promise<unknown>;
}
type HonoLikeMiddleware = (c: HonoLikeContext, next: HonoLikeNext) => Promise<Response | undefined | void>;

export function honoMiddleware(cfg: ServerFaultConfig): HonoLikeMiddleware {
  const fault = serverFaults(cfg);
  const metadataPrefix = resolveMetadataPrefix(cfg.metadataHeader);
  return async (c, next) => {
    const verdict = await fault.maybeInject(c.req.raw);
    if (!verdict) return next().then(() => undefined);
    if (verdict.kind === "synthetic") return verdict.response;
    // annotate: real handler runs, then stamp headers if requested.
    await next();
    if (metadataPrefix && c.res?.headers) {
      for (const [name, value] of attrsToHeaderEntries(verdict.attrs, metadataPrefix)) {
        c.res.headers.set(name, value);
      }
    }
  };
}
