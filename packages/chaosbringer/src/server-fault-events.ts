/**
 * Parser for the `x-chaos-fault-*` response headers emitted by
 * `@mizchi/server-faults` when its `metadataHeader` option is set.
 * Pure function: no I/O, no Playwright surface — invoked from
 * `page.on('response', …)` once per response.
 *
 * Wire-format mirror: this module deliberately re-states the
 * `FaultAttrs` shape from server-faults rather than importing it.
 * The HTTP header contract is the load-bearing interface; the type
 * is shared by convention only. If server-faults adds a kind or an
 * attr, `KNOWN_KINDS` / `NUMERIC_HEADERS` below must be extended in
 * lockstep — `server-fault-contract.test.ts` fails until they are.
 */

// `as const` so the union is derived from the literal tuple — adding a kind
// is one edit instead of two (literal + union string), and TS catches a stray
// case in `kind: ServerFaultKind` if the tuple changes.
//
// server-faults' `abort` is absent on purpose: it tears the connection down
// before any header is sent, so it can never arrive here (its observer is the
// only channel), and neither can its `abortStyle` attr.
const KNOWN_KINDS = ["5xx", "latency", "partial", "slowStream"] as const;
export type ServerFaultKind = (typeof KNOWN_KINDS)[number];
const KNOWN_KIND_SET: ReadonlySet<string> = new Set<string>(KNOWN_KINDS);

export interface ServerFaultEventAttrs {
  kind: ServerFaultKind;
  path: string;
  method: string;
  /** HTTP status code (integral). Set when kind === "5xx". */
  targetStatus?: number;
  /** Sleep duration in milliseconds (may be fractional). Set when kind === "latency". */
  latencyMs?: number;
  /** Bytes of the real body emitted before it was cut (integral). Set when kind === "partial". */
  afterBytes?: number;
  /** Sleep between body chunks in ms (may be fractional). Set when kind === "slowStream". */
  chunkDelayMs?: number;
  /**
   * Rechunk size in bytes (integral). Set when kind === "slowStream" and the
   * body was rechunked; absent when the source chunking was kept.
   */
  chunkSize?: number;
  traceId?: string;
}

export interface ParsedServerFault {
  attrs: ServerFaultEventAttrs;
  /**
   * Duplicated at top level for O(1) collector indexing; `attrs.traceId` is
   * for OTel-attribute parity at the FaultAttrs schema level.
   */
  traceId?: string;
}

type NumericAttr = Exclude<keyof ServerFaultEventAttrs, "kind" | "path" | "method" | "traceId">;
type NumericHeader = readonly [suffix: string, parse: (raw: string) => number];

const parseInteger = (raw: string): number => Number.parseInt(raw, 10);

/**
 * Header suffix and number parser for each numeric attr. The suffixes are
 * server-faults' `FAULT_HEADER_KEY_SUFFIX` entries; the `Record` makes a new
 * numeric attr on `ServerFaultEventAttrs` a type error until it is listed.
 */
const NUMERIC_HEADERS: Record<NumericAttr, NumericHeader> = {
  targetStatus: ["target-status", parseInteger],
  latencyMs: ["latency-ms", Number.parseFloat],
  afterBytes: ["after-bytes", parseInteger],
  chunkDelayMs: ["chunk-delay-ms", Number.parseFloat],
  chunkSize: ["chunk-size", parseInteger],
};

export function parseServerFaultHeaders(
  headers: Headers,
  prefix: string,
): ParsedServerFault | null {
  const kind = headers.get(`${prefix}-kind`);
  if (!kind || !KNOWN_KIND_SET.has(kind)) return null;

  const path = headers.get(`${prefix}-path`);
  const method = headers.get(`${prefix}-method`);
  if (!path || !method) return null;

  const attrs: ServerFaultEventAttrs = {
    kind: kind as ServerFaultKind,
    path,
    method,
  };

  // Malformed numerics drop the field silently rather than rejecting the
  // whole event: kind/path/method already prove a fault occurred — the
  // load-bearing signal — and a bad number should not make the fault
  // invisible to the collector.
  for (const key of Object.keys(NUMERIC_HEADERS) as NumericAttr[]) {
    const [suffix, parse] = NUMERIC_HEADERS[key];
    const raw = headers.get(`${prefix}-${suffix}`);
    if (raw === null) continue;
    const n = parse(raw);
    if (Number.isFinite(n)) attrs[key] = n;
  }

  const traceId = headers.get(`${prefix}-trace-id`) ?? undefined;
  if (traceId) attrs.traceId = traceId;

  return { attrs, traceId };
}
