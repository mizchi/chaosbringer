/**
 * KV namespace fault injection.
 *
 * Wraps a Cloudflare KV namespace so that `get` / `put` / `delete` / `list`
 * occasionally throw or return null — the kind of failure mode that
 * exercises a Worker's graceful-degradation paths and shows up clearly in
 * server-side OTel traces (each KV call is its own span via
 * `@microlabs/otel-cf-workers`'s auto-instrumentation).
 *
 * The wrapper has the same shape as the underlying namespace, so wiring
 * is one line:
 *
 *   const todos = wrapKv(env.TODOS, { rate: 0.1, kinds: ["throw"] });
 */

import { makeRng, type CfFaultObserver, type SeededRng } from "./types.js";

/**
 * The duck-typed KV surface we wrap. Matches the public contract of
 * `KVNamespace` (Cloudflare Workers types) but only at the call sites
 * this wrapper actually proxies through. Consumers pass their real
 * `env.MY_KV` and TS narrows structurally.
 */
export interface KvLike {
  get(key: string, options?: unknown): Promise<unknown>;
  put(key: string, value: unknown, options?: unknown): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  list(options?: unknown): Promise<unknown>;
}

export type KvFaultKind = "throw" | "miss";

export interface WrapKvOptions {
  /** 0..1 — probability of injecting a fault on each call. Default 0. */
  rate: number;
  /**
   * Which fault flavours can fire when the raffle wins. Default `["throw"]`.
   * - `"throw"` rejects the wrapped call with a synthetic Error.
   * - `"miss"` makes `get` resolve to `null` regardless of the underlying
   *   value. Other ops are unaffected (you can't "miss" a `put`); when the
   *   raffle picks `miss` for a non-`get` op it falls through unchanged.
   */
  kinds?: KvFaultKind[];
  /** Reproducible run when set. Otherwise uses Math.random. */
  seed?: number;
  /** KV binding name; surfaced through `observer.onFault` as `fault.target`. */
  bindingName?: string;
  observer?: CfFaultObserver;
}

function pickKind(kinds: KvFaultKind[], rng: SeededRng): KvFaultKind {
  if (kinds.length <= 1) return kinds[0] ?? "throw";
  return kinds[Math.min(kinds.length - 1, Math.floor(rng.next() * kinds.length))];
}

export function wrapKv<T extends KvLike>(kv: T, opts: WrapKvOptions): T {
  const rng = makeRng(opts.seed);
  const kinds = opts.kinds && opts.kinds.length > 0 ? opts.kinds : (["throw"] as KvFaultKind[]);
  const bindingName = opts.bindingName;

  function shouldFire(): false | KvFaultKind {
    if (opts.rate <= 0) return false;
    if (rng.next() >= opts.rate) return false;
    return pickKind(kinds, rng);
  }

  const wrapped: KvLike = {
    async get(key, options) {
      const kind = shouldFire();
      if (kind === "throw") {
        opts.observer?.onFault?.("kv.throw", { "fault.kind": "kv.throw", "fault.target": bindingName, "fault.path": `get:${key}` });
        throw new Error(`cf-faults: synthetic kv.throw on get(${JSON.stringify(key)})`);
      }
      if (kind === "miss") {
        opts.observer?.onFault?.("kv.miss", { "fault.kind": "kv.miss", "fault.target": bindingName, "fault.path": `get:${key}` });
        return null;
      }
      return kv.get(key, options);
    },
    async put(key, value, options) {
      const kind = shouldFire();
      if (kind === "throw") {
        opts.observer?.onFault?.("kv.throw", { "fault.kind": "kv.throw", "fault.target": bindingName, "fault.path": `put:${key}` });
        throw new Error(`cf-faults: synthetic kv.throw on put(${JSON.stringify(key)})`);
      }
      // "miss" doesn't apply to put — fall through unchanged.
      return kv.put(key, value, options);
    },
    async delete(key) {
      const kind = shouldFire();
      if (kind === "throw") {
        opts.observer?.onFault?.("kv.throw", { "fault.kind": "kv.throw", "fault.target": bindingName, "fault.path": `delete:${key}` });
        throw new Error(`cf-faults: synthetic kv.throw on delete(${JSON.stringify(key)})`);
      }
      return kv.delete(key);
    },
    async list(options) {
      const kind = shouldFire();
      if (kind === "throw") {
        opts.observer?.onFault?.("kv.throw", { "fault.kind": "kv.throw", "fault.target": bindingName, "fault.path": "list" });
        throw new Error(`cf-faults: synthetic kv.throw on list`);
      }
      return kv.list(options);
    },
  };
  return wrapped as T;
}
