/**
 * Service Binding fault injection.
 *
 * Wraps a Cloudflare Service Binding (a `Fetcher`) so that `fetch()`
 * occasionally returns a 5xx response or throws. Use this to test how
 * Worker A degrades when Worker B is unavailable, without touching
 * Worker B's deployment.
 *
 *   const enricher = wrapServiceBinding(env.ENRICHER, {
 *     status5xxRate: 0.3,
 *     abortRate: 0.05,
 *   });
 */

import { makeRng, type CfFaultObserver, type SeededRng } from "./types.js";

/**
 * The duck-typed surface of a Cloudflare `Fetcher`. Matches what
 * `env.MY_SERVICE` exposes for service-binding RPC.
 */
export interface FetcherLike {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

export interface WrapServiceBindingOptions {
  /** 0..1 — probability of returning a synthetic 5xx response. Default 0. */
  status5xxRate?: number;
  /** Default 503. */
  status5xxCode?: 500 | 502 | 503 | 504;
  /** 0..1 — probability of throwing instead of returning a response. Default 0. */
  abortRate?: number;
  /** Reproducible run when set. */
  seed?: number;
  /** Service binding name; surfaced as `fault.target`. */
  bindingName?: string;
  observer?: CfFaultObserver;
}

function pathOf(input: string | Request): string {
  try {
    const u = new URL(typeof input === "string" ? input : input.url);
    return u.pathname;
  } catch {
    return "";
  }
}

export function wrapServiceBinding<T extends FetcherLike>(
  fetcher: T,
  opts: WrapServiceBindingOptions,
): T {
  const rng: SeededRng = makeRng(opts.seed);
  const r5 = opts.status5xxRate ?? 0;
  const rA = opts.abortRate ?? 0;
  const code = opts.status5xxCode ?? 503;
  const target = opts.bindingName;

  const wrapped: FetcherLike = {
    async fetch(input, init) {
      const path = pathOf(input);

      if (r5 > 0 && rng.next() < r5) {
        opts.observer?.onFault?.("service.5xx", {
          "fault.kind": "service.5xx",
          "fault.target": target,
          "fault.path": path,
          "fault.target_status": code,
        });
        return Response.json(
          { error: "cf-faults: synthetic service.5xx", path, status: code },
          { status: code },
        );
      }

      if (rA > 0 && rng.next() < rA) {
        opts.observer?.onFault?.("service.abort", {
          "fault.kind": "service.abort",
          "fault.target": target,
          "fault.path": path,
        });
        throw new Error(`cf-faults: synthetic service.abort${path ? ` on ${path}` : ""}`);
      }

      return fetcher.fetch(input, init);
    },
  };
  return wrapped as T;
}
