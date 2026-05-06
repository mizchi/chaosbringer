/**
 * Shared types for @mizchi/cf-faults. We deliberately avoid pulling
 * `@cloudflare/workers-types` so the package stays zero-dep — consumers
 * pass their own KV / Fetcher instances and TypeScript narrows them
 * structurally.
 */

export type CfFaultKind = "kv.throw" | "kv.miss" | "service.5xx" | "service.abort";

/**
 * Stable attribute schema fed to `observer.onFault`. Mirrors the
 * `fault.*` namespace established in `@mizchi/server-faults` so consumers
 * can reuse the same OTel / Prometheus pipeline across both packages.
 */
export interface CfFaultAttrs {
  "fault.kind": CfFaultKind;
  /** KV binding name or service binding name, when known to the wrapper. */
  "fault.target"?: string;
  /** KV op or service-binding URL pathname. */
  "fault.path"?: string;
  /** For service.5xx, the synthetic HTTP status. */
  "fault.target_status"?: number;
}

export interface CfFaultObserver {
  onFault?: (kind: CfFaultKind, attrs: CfFaultAttrs) => void;
}

/**
 * Mulberry32 PRNG. Tiny, fast, fine for 0..1 raffle decisions; not for
 * cryptography. Re-implemented (rather than imported from server-faults)
 * to keep cf-faults a leaf package with no internal sibling deps.
 */
export interface SeededRng {
  next(): number;
}

export function mulberry32(seed: number): SeededRng {
  let s = seed >>> 0;
  return {
    next() {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

export function makeRng(seed: number | undefined): SeededRng {
  return seed !== undefined ? mulberry32(seed) : { next: () => Math.random() };
}
