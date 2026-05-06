/**
 * Framework-agnostic server-side fault injection.
 *
 * Sits between the network-side fault injection (request interception
 * outside the server) and any client-side mocking. Takes a Web Standard
 * `Request`, returns a `Response | null`. `null` means "no fault, the
 * normal handler should run". The library is independent of any HTTP
 * framework; users wire it as a 1-2 line middleware.
 *
 * 5xx is exclusive of latency in the same request — a single fault per
 * request keeps observability data clean and RNG consumption deterministic
 * (1 roll for 5xx, conditionally 1 roll for latency).
 */

export type FaultKind = "5xx" | "latency";

/**
 * Stable attribute schema fed to `observer.onFault`.
 *
 * Modeled on OTel semantic conventions: keys are namespaced under `fault.*`,
 * values are primitive scalars so they map cleanly to OTel attributes,
 * Prometheus labels, Datadog tags, etc. Required keys are always present;
 * optional keys appear only when meaningful for the fault kind. Treat this
 * shape as part of the public contract — additions are backward-compatible,
 * renames are not.
 */
export interface FaultAttrs {
  /** Mirror of the kind argument; included so an attrs object is self-describing if it ever travels without context. */
  "fault.kind": FaultKind;
  /** URL pathname (no host, no query). */
  "fault.path": string;
  /** Uppercase HTTP method. */
  "fault.method": string;
  /** Set when `fault.kind === "5xx"`. The synthetic HTTP status that was returned. */
  "fault.target_status"?: number;
  /** Set when `fault.kind === "latency"`. Milliseconds actually slept. */
  "fault.latency_ms"?: number;
}

export interface ServerFaultObserver {
  onFault?: (kind: FaultKind, attrs: FaultAttrs) => void;
}

export interface ServerFaultConfig {
  /** 0..1, default 0. */
  status5xxRate?: number;
  /** Default 503. */
  status5xxCode?: 500 | 502 | 503 | 504;
  /** 0..1, default 0. */
  latencyRate?: number;
  /** Sleep duration when the latency raffle wins. Number = constant ms; range = uniform pick. */
  latencyMs?: number | { minMs: number; maxMs: number };
  /** RegExp or pattern string. Only matching paths are considered for fault injection. */
  pathPattern?: RegExp | string;
  /** Optional. When set, fault selection (which raffles win) is reproducible across runs. */
  seed?: number;
  observer?: ServerFaultObserver;
}

export interface ServerFaultHandle {
  maybeInject: (req: Request) => Promise<Response | null>;
}

interface SeededRng {
  next(): number;
}

function mulberry32(seed: number): SeededRng {
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

function pickLatencyMs(spec: ServerFaultConfig["latencyMs"]): number {
  if (typeof spec === "number") return spec;
  if (spec) return spec.minMs + Math.random() * (spec.maxMs - spec.minMs);
  return 0;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function serverFaults(cfg: ServerFaultConfig): ServerFaultHandle {
  const pattern =
    cfg.pathPattern instanceof RegExp
      ? cfg.pathPattern
      : cfg.pathPattern
        ? new RegExp(cfg.pathPattern)
        : null;

  const rng: SeededRng = cfg.seed !== undefined ? mulberry32(cfg.seed) : { next: () => Math.random() };

  return {
    async maybeInject(req: Request): Promise<Response | null> {
      const url = new URL(req.url);
      if (pattern && !pattern.test(url.pathname)) return null;

      const method = req.method.toUpperCase();
      const r5 = cfg.status5xxRate ?? 0;
      if (r5 > 0 && rng.next() < r5) {
        const status = cfg.status5xxCode ?? 503;
        cfg.observer?.onFault?.("5xx", {
          "fault.kind": "5xx",
          "fault.path": url.pathname,
          "fault.method": method,
          "fault.target_status": status,
        });
        return Response.json(
          { error: "chaos: synthetic 5xx", path: url.pathname, status },
          { status },
        );
      }

      const rL = cfg.latencyRate ?? 0;
      if (rL > 0 && rng.next() < rL) {
        const ms = pickLatencyMs(cfg.latencyMs);
        cfg.observer?.onFault?.("latency", {
          "fault.kind": "latency",
          "fault.path": url.pathname,
          "fault.method": method,
          "fault.latency_ms": ms,
        });
        await sleep(ms);
      }
      return null;
    },
  };
}
