/**
 * Express adapter for @mizchi/server-faults.
 *
 * Bridges Express's Node `IncomingMessage` / `ServerResponse` to the
 * Web Standard `Request` / `Response` that `serverFaults()` speaks.
 * Body forwarding is intentionally left to upstream middleware
 * (`express.json()` etc.) — fault decisions are driven by URL + headers,
 * which we always have, so we never need to read the request body.
 */

import {
  attrsToHeaderEntries,
  resolveMetadataPrefix,
  serverFaults,
  type ServerFaultConfig,
} from "../server-faults.js";

// Loosely-typed Express surface to keep server-faults zero-dep.
interface ExpressLikeRequest {
  method: string;
  originalUrl?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
}
interface ExpressLikeResponse {
  status(code: number): ExpressLikeResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): unknown;
}
type ExpressLikeNext = (err?: unknown) => void;

function toWebRequest(req: ExpressLikeRequest): Request {
  const host = (req.headers.host as string | undefined) ?? "localhost";
  const path = req.originalUrl ?? req.url ?? "/";
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) headers.append(k, item);
    } else {
      headers.set(k, v);
    }
  }
  return new Request(`http://${host}${path}`, {
    method: req.method,
    headers,
  });
}

export function expressMiddleware(
  cfg: ServerFaultConfig,
): (req: ExpressLikeRequest, res: ExpressLikeResponse, next: ExpressLikeNext) => Promise<void> {
  const fault = serverFaults(cfg);
  const metadataPrefix = resolveMetadataPrefix(cfg.metadataHeader);
  return async (req, res, next) => {
    try {
      const verdict = await fault.maybeInject(toWebRequest(req));
      if (!verdict) {
        next();
        return;
      }
      if (verdict.kind === "synthetic") {
        res.status(verdict.response.status);
        verdict.response.headers.forEach((value, key) => {
          if (key.toLowerCase() === "content-type") return; // res.json sets this
          res.setHeader(key, value);
        });
        res.json(await verdict.response.json());
        return;
      }
      if (verdict.kind === "annotate") {
        // Stamp headers BEFORE calling next() — Express buffers headers on the
        // response object until the handler responds. Stamping after `next()`
        // would race the handler's own `res.send` / `res.json`. If a downstream
        // layer hands back a `Response` with frozen headers (some custom
        // bridges do this), `res.setHeader(...)` will throw — that is the
        // documented contract.
        if (metadataPrefix) {
          for (const [name, value] of attrsToHeaderEntries(verdict.attrs, metadataPrefix)) {
            res.setHeader(name, value);
          }
        }
        next();
        return;
      }
      const _exhaustive: never = verdict;
      void _exhaustive;
    } catch (err) {
      next(err);
    }
  };
}
