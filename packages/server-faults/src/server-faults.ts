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
  kind: FaultKind;
  path: string;
  method: string;
  targetStatus?: number;
  latencyMs?: number;
  /** Trace-id from incoming traceparent (W3C Trace Context). 32 lowercase hex. */
  traceId?: string;
}

/**
 * Outcome of a fault raffle.
 *
 * - `synthetic`: a fault response was minted; the adapter must short-circuit
 *   the real handler and return `response`.
 * - `annotate`: no synthetic response, but the request was perturbed (e.g.
 *   latency was injected). The adapter should run the real handler and
 *   surface `attrs` (as response headers, span attributes, etc.).
 * - `null`: bypass / exempt / no raffle won — pass through unchanged.
 */
export type FaultVerdict =
  | { kind: "synthetic"; response: Response; attrs: FaultAttrs }
  | { kind: "annotate"; attrs: FaultAttrs }
  | null;

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
  /**
   * Header name (case-insensitive) that, when present on a request, makes that
   * request bypass all fault raffles. Use this to keep test fixture / warm-up
   * traffic out of the chaos surface.
   */
  bypassHeader?: string;
  /**
   * RegExp or pattern string. Requests whose pathname matches are skipped
   * unconditionally (e.g. health checks, seed endpoints). Evaluated before
   * `pathPattern`; an exempt request never has a raffle rolled, even if it
   * also matches `pathPattern`.
   */
  exemptPathPattern?: RegExp | string;
  /** Optional. When set, fault selection (which raffles win) is reproducible across runs. */
  seed?: number;
  observer?: ServerFaultObserver;
  /**
   * When set, server-faults mirrors `FaultAttrs` onto response headers so
   * out-of-process consumers (e.g. chaosbringer's `chaos()` crawler) can
   * observe server-side faults without sharing memory with the server.
   *
   * Header naming: `{prefix}-{kebab(key)}` where `key` is a TS attrs
   * property name and `kebab` lower-cases the camelCase boundary
   * (e.g. `targetStatus` → `{prefix}-target-status`). `true` uses
   * the default prefix `"x-chaos-fault"`.
   */
  metadataHeader?: boolean | { prefix?: string };
}

export interface ServerFaultHandle {
  maybeInject: (req: Request) => Promise<FaultVerdict>;
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

/**
 * Coerce a user-supplied RegExp/string pattern into a stateless RegExp.
 *
 * `RegExp.test()` is **stateful** when the pattern carries the `g` or `y`
 * flag — `lastIndex` advances between calls, so a second call against the
 * same input can spuriously miss. That would make exempt paths
 * intermittently receive injected faults, violating the documented
 * "passed through unconditionally" contract. Strip those two flags so
 * every call is positional from index 0; preserve `i` / `m` / `s` / `u`
 * since they change *what* matches, not *how* the index moves.
 */
function compileStatelessPattern(p: RegExp | string | undefined): RegExp | null {
  if (!p) return null;
  if (typeof p === "string") return new RegExp(p);
  if (!/[gy]/.test(p.flags)) return p;
  return new RegExp(p.source, p.flags.replace(/[gy]/g, ""));
}

const TRACEPARENT_RE = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/;

function extractTraceId(req: Request): string | undefined {
  const tp = req.headers.get("traceparent");
  if (!tp) return undefined;
  const m = TRACEPARENT_RE.exec(tp);
  return m ? m[1] : undefined;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const DEFAULT_METADATA_PREFIX = "x-chaos-fault";

/**
 * Materialise a `FaultAttrs` value as a list of HTTP-header pairs.
 *
 * camelCase keys are lowered into kebab-case (`targetStatus` →
 * `target-status`) and then prefixed. Undefined optional values are
 * dropped. Exposed so framework adapters can apply the same headers
 * to the `annotate` verdict path (where the real handler's response
 * is what actually reaches the wire).
 */
export function attrsToHeaderEntries(attrs: FaultAttrs, prefix: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    // camelCase → kebab-case (e.g. `targetStatus` → `target-status`).
    const tail = k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    out.push([`${prefix}-${tail}`, String(v)]);
  }
  return out;
}

/**
 * Resolve `metadataHeader` config to a concrete prefix string, or `null`
 * if disabled. Exposed for adapters that handle the `annotate` branch.
 */
export function resolveMetadataPrefix(opt: ServerFaultConfig["metadataHeader"]): string | null {
  if (!opt) return null;
  if (opt === true) return DEFAULT_METADATA_PREFIX;
  return opt.prefix ?? DEFAULT_METADATA_PREFIX;
}

export function serverFaults(cfg: ServerFaultConfig): ServerFaultHandle {
  const pattern = compileStatelessPattern(cfg.pathPattern);
  const exemptPattern = compileStatelessPattern(cfg.exemptPathPattern);

  const bypassHeader = cfg.bypassHeader?.toLowerCase();

  const metadataPrefix = resolveMetadataPrefix(cfg.metadataHeader);

  const rng: SeededRng = cfg.seed !== undefined ? mulberry32(cfg.seed) : { next: () => Math.random() };

  return {
    async maybeInject(req: Request): Promise<FaultVerdict> {
      if (bypassHeader && req.headers.has(bypassHeader)) return null;

      const url = new URL(req.url);
      if (exemptPattern && exemptPattern.test(url.pathname)) return null;
      if (pattern && !pattern.test(url.pathname)) return null;

      const method = req.method.toUpperCase();
      const traceId = extractTraceId(req);
      const r5 = cfg.status5xxRate ?? 0;
      if (r5 > 0 && rng.next() < r5) {
        const status = cfg.status5xxCode ?? 503;
        const attrs5xx: FaultAttrs = {
          kind: "5xx",
          path: url.pathname,
          method,
          targetStatus: status,
        };
        if (traceId !== undefined) attrs5xx.traceId = traceId;
        // Frozen because the same reference is handed to observer.onFault and
        // returned in the verdict; either consumer mutating it would corrupt
        // the other's view.
        Object.freeze(attrs5xx);
        cfg.observer?.onFault?.("5xx", attrs5xx);
        const headers = new Headers();
        if (metadataPrefix) {
          for (const [name, value] of attrsToHeaderEntries(attrs5xx, metadataPrefix)) {
            headers.set(name, value);
          }
        }
        const response = Response.json(
          { error: "chaos: synthetic 5xx", path: url.pathname, status },
          { status, headers },
        );
        return { kind: "synthetic", response, attrs: attrs5xx };
      }

      const rL = cfg.latencyRate ?? 0;
      if (rL > 0 && rng.next() < rL) {
        const ms = pickLatencyMs(cfg.latencyMs);
        const attrsLat: FaultAttrs = {
          kind: "latency",
          path: url.pathname,
          method,
          latencyMs: ms,
        };
        if (traceId !== undefined) attrsLat.traceId = traceId;
        Object.freeze(attrsLat);
        cfg.observer?.onFault?.("latency", attrsLat);
        await sleep(ms);
        return { kind: "annotate", attrs: attrsLat };
      }
      return null;
    },
  };
}

/**
 * Map a flat `FaultAttrs` to the OTel-style dotted attribute schema
 * (`fault.kind`, `fault.target_status`, …) for consumers that pipe
 * fault events directly into an OTel exporter. Undefined optional
 * keys are dropped so the output is tight.
 *
 * The `Record<keyof FaultAttrs, string>` constraint forces every new
 * `FaultAttrs` key to be added to the map at type-check time — adding
 * a field to the interface without updating the map produces a
 * compile error, so the translator never silently omits new attrs.
 */
const FAULT_KEY_MAP: Record<keyof FaultAttrs, string> = {
  kind: "fault.kind",
  path: "fault.path",
  method: "fault.method",
  targetStatus: "fault.target_status",
  latencyMs: "fault.latency_ms",
  traceId: "fault.trace_id",
};

export function toOtelAttrs(a: FaultAttrs): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const k of Object.keys(FAULT_KEY_MAP) as Array<keyof FaultAttrs>) {
    const v = a[k];
    if (v !== undefined) out[FAULT_KEY_MAP[k]] = v;
  }
  return out;
}
