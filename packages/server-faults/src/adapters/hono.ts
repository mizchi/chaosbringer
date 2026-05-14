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
  type AbortStyle,
  type ServerFaultConfig,
} from "../server-faults.js";
import { truncateStream } from "../stream-transforms.js";

/**
 * Error thrown by `honoMiddleware` when an abort fault wins.
 *
 * Hono targets Node, Bun, Workers, Deno, etc. — there is no portable
 * "destroy the socket" call we can make from the middleware. Throwing a
 * tagged error is the only adapter-agnostic option: Workers' `fetch()`
 * propagates the throw as a connection error, while Node-based Hono users
 * can install an `app.onError` handler that recognises this error and
 * calls `c.env.incoming.socket.destroy()` for a real TCP teardown.
 */
export class ServerFaultsAbortError extends Error {
  readonly abortStyle: AbortStyle;
  constructor(abortStyle: AbortStyle) {
    super("server-faults: synthetic abort");
    this.name = "ServerFaultsAbortError";
    this.abortStyle = abortStyle;
  }
}

export interface HonoLikeContext {
  req: { raw: Request };
  // In real Hono `c.res` is a getter/setter backed by a lazily-synthesized
  // Response. The optional marker is for structurally-typed test mocks that
  // omit it on the no-fault path; the union form accepts both a full
  // `Response` (real Hono / the `partial` verdict needs to set a new one)
  // and a minimal `{ headers }` stand-in (existing annotate tests).
  res?: Response | { headers: Headers };
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
    if (verdict.kind === "abort") {
      // No portable socket teardown across Hono's runtime targets — throw a
      // tagged error and let either the runtime (Workers / Bun) treat it as
      // a connection error, or a Node-host's onError handler call
      // `c.env.incoming.socket.destroy()` if a real TCP-level abort is
      // required. Metadata headers cannot be delivered on this path.
      throw new ServerFaultsAbortError(verdict.abortStyle);
    }
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
    if (verdict.kind === "partial") {
      // Real handler runs, then we wrap its response body in a truncating
      // stream. The bytes-after-N truncation matches real upstream cuts
      // (OOM, pod evict). `Content-Length` is stripped because the
      // declared length no longer matches the bytes actually delivered —
      // leaving it intact would make standards-compliant clients hang
      // waiting for the missing bytes, masking the failure mode we want
      // to expose.
      await next();
      const current = c.res;
      if (!isFullResponse(current)) return;
      if (current.body === null) {
        // Null-body statuses (204 / 205 / 304) have nothing to truncate.
        // The Response constructor also forbids passing a body for them,
        // so attempting to wrap would throw. Stamp metadata headers on
        // the existing Response (if enabled) and leave the body alone.
        if (metadataPrefix) {
          for (const [name, value] of attrsToHeaderEntries(verdict.attrs, metadataPrefix)) {
            current.headers.set(name, value);
          }
        }
        return;
      }
      const truncated = truncateStream(current.body, verdict.afterBytes);
      const headers = new Headers(current.headers);
      headers.delete("content-length");
      if (metadataPrefix) {
        for (const [name, value] of attrsToHeaderEntries(verdict.attrs, metadataPrefix)) {
          headers.set(name, value);
        }
      }
      c.res = new Response(truncated, {
        status: current.status,
        statusText: current.statusText,
        headers,
      });
      return;
    }
    const _exhaustive: never = verdict;
    void _exhaustive;
  };
}

function isFullResponse(r: Response | { headers: Headers } | undefined): r is Response {
  // Discriminate via the `body` property: real Response always has it
  // (possibly null), the `{ headers }` test-mock shape does not.
  return !!r && "body" in r;
}
