/**
 * Hono adapter for @mizchi/server-faults.
 *
 * `c.req.raw` is a Web Standard Request, so the adapter is mostly a thin
 * wrapper around `serverFaults({...}).maybeInject(req)`. The latency
 * (annotate) path requires running the real handler first and then
 * stamping the metadata headers onto `c.res.headers` afterwards.
 *
 * No `import "hono"` on purpose — server-faults stays zero-dep and
 * consumers compile against their own Hono version.
 */

import {
  attrsToHeaderEntries,
  resolveMetadataPrefix,
  serverFaults,
  type ServerFaultConfig,
} from "../server-faults.js";

export interface HonoLikeContext {
  req: { raw: Request };
  // c.res is always populated in real Hono (lazy getter that synthesizes a
  // Response if none was set). The optional marker here is for structurally-
  // typed test mocks that omit it on the no-fault path.
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
    if (!verdict) {
      await next();
      return;
    }
    if (verdict.kind === "synthetic") return verdict.response;
    if (verdict.kind === "annotate") {
      // Real handler runs, then stamp headers. Mutating `c.res.headers` after
      // the handler returns relies on Hono's live `Headers` object — if a
      // handler returns a Response built with frozen headers, this `.set()`
      // throws loudly. That is the documented contract.
      await next();
      if (metadataPrefix && c.res?.headers) {
        for (const [name, value] of attrsToHeaderEntries(verdict.attrs, metadataPrefix)) {
          c.res.headers.set(name, value);
        }
      }
      return;
    }
    const _exhaustive: never = verdict;
    void _exhaustive;
  };
}
