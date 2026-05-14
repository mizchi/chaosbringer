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

export type FaultKind = "5xx" | "latency" | "abort" | "partial" | "slowStream";

/**
 * How an abort fault tears down the connection.
 *
 * - `hangup`: clean half-close (Node `socket.end()`). The peer sees EOF on
 *   read with no error; equivalent to the server politely terminating.
 * - `reset`: forced reset (Node `socket.destroy(err)`). The peer sees
 *   `ECONNRESET` / `net::ERR_CONNECTION_RESET`.
 *
 * Not every framework can express both — see per-adapter docs.
 */
export type AbortStyle = "hangup" | "reset";

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
  /** Populated only on `kind: "abort"`. */
  abortStyle?: AbortStyle;
  /** Populated only on `kind: "partial"`. Number of bytes emitted from the real body before close. */
  afterBytes?: number;
  /** Populated only on `kind: "slowStream"`. Milliseconds slept between chunks. */
  chunkDelayMs?: number;
  /** Populated only on `kind: "slowStream"`. Rechunk size in bytes (omitted = leave source chunking intact). */
  chunkSize?: number;
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
 * - `abort`: the adapter must tear down the connection without sending a
 *   response. `metadataHeader` cannot round-trip on this path — no headers
 *   are ever delivered — so the only observability channel is `observer`.
 * - `partial`: the real handler must run; the adapter then wraps the response
 *   body so that only the first `afterBytes` bytes are emitted before the
 *   stream is closed. Status + headers are delivered normally (so
 *   `metadataHeader` works), but `Content-Length` MUST be stripped or
 *   recomputed by the adapter — the real value no longer matches.
 * - `slowStream`: the real handler runs; the adapter wraps the response body
 *   so each chunk is emitted with `chunkDelayMs` of sleep between. Status +
 *   headers are delivered immediately, matching real-world "congested
 *   backend" / "throttled pod" behaviour. `Content-Length` is preserved when
 *   `chunkSize` is omitted (rechunking doesn't change total length).
 * - `null`: bypass / exempt / no raffle won — pass through unchanged.
 */
export type FaultVerdict =
  | { kind: "synthetic"; response: Response; attrs: FaultAttrs }
  | { kind: "annotate"; attrs: FaultAttrs }
  | { kind: "abort"; attrs: FaultAttrs; abortStyle: AbortStyle }
  | { kind: "partial"; attrs: FaultAttrs; afterBytes: number }
  | { kind: "slowStream"; attrs: FaultAttrs; chunkDelayMs: number; chunkSize?: number }
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
  /**
   * 0..1, default 0. Probability of tearing down the connection without
   * sending a response. Rolled before `status5xxRate` and `latencyRate` —
   * a winning abort short-circuits all other kinds in the same request.
   */
  abortRate?: number;
  /** Connection-termination style when the abort raffle wins. Default `"hangup"`. */
  abortStyle?: AbortStyle;
  /**
   * 0..1, default 0. Probability of truncating the response body after a
   * fixed number of bytes have been emitted. Rolled after `abort` and
   * `status5xxRate` but before `latencyRate` — partial lets the handler
   * run (like latency does) but transforms its output.
   *
   * Adapter support: Hono only at present. Express / Koa / Fastify throw
   * at middleware construction when set, since they require Node-level
   * `res.write` interception that is not yet implemented.
   */
  partialResponseRate?: number;
  /**
   * Bytes of the real response body to emit before closing. Default 0
   * (close immediately after headers). The truncation point lands on a
   * raw byte boundary, so multi-byte UTF-8 sequences may be split — that
   * is the realistic failure mode, not a bug.
   */
  partialResponseAfterBytes?: number;
  /**
   * Windowed 5xx flapping: inside a repeating `windowMs` period, the
   * first `badMs` of each cycle returns 5xx unconditionally; outside
   * that slice the request falls through to the other raffles.
   *
   * Models the canonical retry-with-backoff scenario: a constant 5xx
   * rate is too easy because clients give up, but a 5-second sick
   * window inside a 30-second healthy window catches retry storms,
   * alerting de-dup quirks, and circuit-breaker thresholds that a
   * stateless `status5xxRate` cannot reproduce.
   *
   * **Composes with `status5xxRate` via OR**: statusFlapping is checked
   * first; if the window is bad, it short-circuits and emits 5xx. If
   * the window is healthy, `status5xxRate` still rolls normally. So
   * setting both yields "always bad inside the window, sometimes bad
   * outside" — the layered shape most users want for testing.
   *
   * **Not seed-reproducible.** Time-based gates break the "same seed
   * → same outcomes" contract because wall-clock varies between runs.
   * Distributed deployments needing phase-locked flapping across
   * multiple instances can pass `phaseOffsetMs` to stagger or align.
   */
  statusFlapping?: {
    /** Status code returned during the bad window. Default 503. */
    code?: 500 | 502 | 503 | 504;
    /** Full period of the flap, in milliseconds. */
    windowMs: number;
    /** How long inside each period the server is "sick". Must be ≤ `windowMs`. */
    badMs: number;
    /**
     * Optional millisecond offset added to `Date.now()` before the
     * modulo. Lets multiple instances of `serverFaults` align (same
     * offset → in phase) or stagger (different offsets → out of phase).
     * Defaults to 0.
     */
    phaseOffsetMs?: number;
  };
  /**
   * Slow-stream the response body: emit each chunk with a sleep in
   * between. Mimics congested backend / throttled pod / slow disk where
   * status + headers arrive immediately but bytes trickle. The whole-
   * request `latencyMs` cannot expose this — it delays the response
   * before it starts and then dumps the body in one shot.
   *
   * `chunkSize` (optional) rechunks the source body to fixed-size pieces
   * before delaying — useful when the source is a single large chunk and
   * you want to spread the slowness across many small ones. Omitting it
   * preserves whatever chunking the source emits.
   *
   * Adapter support: Hono only at present. Express / Koa / Fastify throw
   * at construction when set, same as `partialResponseRate`.
   */
  slowStreaming?: {
    rate: number;
    chunkDelayMs: number;
    chunkSize?: number;
  };
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
 * Header-name suffixes for each `FaultAttrs` key.
 *
 * `Record<keyof FaultAttrs, string>` forces every new key on `FaultAttrs`
 * to be added here at type-check time. A naive camelCase→kebab regex
 * silently mangles consecutive caps (`traceID` → `trace-i-d`) and leading
 * caps; a hand-written map dodges both and keeps the wire format stable
 * even if a contributor adds a key without thinking about encoding.
 */
const FAULT_HEADER_KEY_SUFFIX: Record<keyof FaultAttrs, string> = {
  kind: "kind",
  path: "path",
  method: "method",
  targetStatus: "target-status",
  latencyMs: "latency-ms",
  abortStyle: "abort-style",
  afterBytes: "after-bytes",
  chunkDelayMs: "chunk-delay-ms",
  chunkSize: "chunk-size",
  traceId: "trace-id",
};

// NOTE: attrsToHeaderEntries and resolveMetadataPrefix are exported for the
// in-package framework adapters (hono / express / fastify / koa) to reuse the
// canonical header encoding on the annotate path. They are intentionally NOT
// re-exported from `index.ts` and carry no stability guarantee for external
// consumers — deep-importing them is unsupported.

/**
 * Materialise a `FaultAttrs` value as a list of HTTP-header pairs.
 *
 * Keys are translated through `FAULT_HEADER_KEY_SUFFIX` (camelCase →
 * kebab-case), then prefixed. Undefined optional values are dropped.
 * Used by both the synthetic-response path here and by adapters on the
 * annotate verdict path so the wire format stays identical across
 * fault kinds.
 */
export function attrsToHeaderEntries(attrs: FaultAttrs, prefix: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const k of Object.keys(FAULT_HEADER_KEY_SUFFIX) as Array<keyof FaultAttrs>) {
    const v = attrs[k];
    if (v === undefined) continue;
    out.push([`${prefix}-${FAULT_HEADER_KEY_SUFFIX[k]}`, String(v)]);
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

/**
 * Throw a clear, sourceable error if a config asks for a fault kind the
 * caller's adapter cannot honour. Each Node-based adapter (express,
 * fastify, koa) calls this with its name; the Hono adapter does not,
 * because it supports the full verdict set.
 *
 * Failing at middleware-construction time is a deliberate choice: a
 * silent fall-through on a request would let `partialResponseRate=0.1`
 * appear to "work" until a verdict actually fires, at which point the
 * adapter would either no-op (masking chaos) or crash mid-request.
 * Construction-time validation surfaces the misconfiguration before any
 * traffic touches it.
 */
export function assertAdapterSupportsConfig(cfg: ServerFaultConfig, adapter: string): void {
  if ((cfg.partialResponseRate ?? 0) > 0) {
    throw new Error(
      `server-faults: ${adapter} adapter does not yet support partialResponseRate. ` +
        `Use honoMiddleware for stream-based faults, or wait for Node-res interception.`,
    );
  }
  if ((cfg.slowStreaming?.rate ?? 0) > 0) {
    throw new Error(
      `server-faults: ${adapter} adapter does not yet support slowStreaming. ` +
        `Use honoMiddleware for stream-based faults, or wait for Node-res interception.`,
    );
  }
}

/**
 * Mint a `synthetic 5xx` verdict. Shared by the probabilistic
 * `status5xxRate` raffle and the windowed `statusFlapping` gate — both
 * produce the same wire-level outcome (a JSON 5xx) and the same observer
 * event, only the decision rule differs.
 */
function mintSyntheticFault(
  status: 500 | 502 | 503 | 504,
  path: string,
  method: string,
  traceId: string | undefined,
  cfg: ServerFaultConfig,
  metadataPrefix: string | null,
): { kind: "synthetic"; response: Response; attrs: FaultAttrs } {
  const attrs: FaultAttrs = {
    kind: "5xx",
    path,
    method,
    targetStatus: status,
  };
  if (traceId !== undefined) attrs.traceId = traceId;
  // Frozen because the same reference is handed to observer.onFault and
  // returned in the verdict; either consumer mutating it would corrupt
  // the other's view.
  Object.freeze(attrs);
  cfg.observer?.onFault?.("5xx", attrs);
  const headers = new Headers();
  if (metadataPrefix) {
    for (const [name, value] of attrsToHeaderEntries(attrs, metadataPrefix)) {
      headers.set(name, value);
    }
  }
  const response = Response.json(
    { error: "chaos: synthetic 5xx", path, status },
    { status, headers },
  );
  return { kind: "synthetic", response, attrs };
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

      const rA = cfg.abortRate ?? 0;
      if (rA > 0 && rng.next() < rA) {
        const abortStyle: AbortStyle = cfg.abortStyle ?? "hangup";
        const attrsAbort: FaultAttrs = {
          kind: "abort",
          path: url.pathname,
          method,
          abortStyle,
        };
        if (traceId !== undefined) attrsAbort.traceId = traceId;
        // No metadata headers on the abort path: the connection is torn down
        // before any headers can be delivered. Observers are the only channel.
        Object.freeze(attrsAbort);
        cfg.observer?.onFault?.("abort", attrsAbort);
        return { kind: "abort", attrs: attrsAbort, abortStyle };
      }

      const flap = cfg.statusFlapping;
      if (flap && flap.windowMs > 0 && flap.badMs > 0) {
        const offset = flap.phaseOffsetMs ?? 0;
        const phase = ((Date.now() - offset) % flap.windowMs + flap.windowMs) % flap.windowMs;
        if (phase < flap.badMs) {
          const status = flap.code ?? 503;
          return mintSyntheticFault(status, url.pathname, method, traceId, cfg, metadataPrefix);
        }
      }

      const r5 = cfg.status5xxRate ?? 0;
      if (r5 > 0 && rng.next() < r5) {
        const status = cfg.status5xxCode ?? 503;
        return mintSyntheticFault(status, url.pathname, method, traceId, cfg, metadataPrefix);
      }

      const rP = cfg.partialResponseRate ?? 0;
      if (rP > 0 && rng.next() < rP) {
        const afterBytes = cfg.partialResponseAfterBytes ?? 0;
        const attrsPartial: FaultAttrs = {
          kind: "partial",
          path: url.pathname,
          method,
          afterBytes,
        };
        if (traceId !== undefined) attrsPartial.traceId = traceId;
        Object.freeze(attrsPartial);
        cfg.observer?.onFault?.("partial", attrsPartial);
        return { kind: "partial", attrs: attrsPartial, afterBytes };
      }

      const slowCfg = cfg.slowStreaming;
      const rS = slowCfg?.rate ?? 0;
      if (rS > 0 && rng.next() < rS) {
        const chunkDelayMs = slowCfg!.chunkDelayMs;
        const chunkSize = slowCfg!.chunkSize;
        const attrsSlow: FaultAttrs = {
          kind: "slowStream",
          path: url.pathname,
          method,
          chunkDelayMs,
        };
        if (chunkSize !== undefined) attrsSlow.chunkSize = chunkSize;
        if (traceId !== undefined) attrsSlow.traceId = traceId;
        Object.freeze(attrsSlow);
        cfg.observer?.onFault?.("slowStream", attrsSlow);
        return chunkSize !== undefined
          ? { kind: "slowStream", attrs: attrsSlow, chunkDelayMs, chunkSize }
          : { kind: "slowStream", attrs: attrsSlow, chunkDelayMs };
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
  abortStyle: "fault.abort_style",
  afterBytes: "fault.after_bytes",
  chunkDelayMs: "fault.chunk_delay_ms",
  chunkSize: "fault.chunk_size",
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
