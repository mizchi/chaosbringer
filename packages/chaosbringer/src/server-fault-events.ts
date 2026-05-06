/**
 * Parser for the `x-chaos-fault-*` response headers emitted by
 * `@mizchi/server-faults` when its `metadataHeader` option is set.
 * Pure function: no I/O, no Playwright surface — invoked from
 * `page.on('response', …)` once per response.
 *
 * Wire-format mirror: this module deliberately re-states the
 * `FaultAttrs` shape from server-faults rather than importing it.
 * The HTTP header contract is the load-bearing interface; the type
 * is shared by convention only. If server-faults adds a kind, the
 * `KNOWN_KINDS` tuple below must be extended in lockstep.
 */

// `as const` so the union is derived from the literal tuple — adding a kind
// is one edit instead of two (literal + union string), and TS catches a stray
// case in `kind: ServerFaultKind` if the tuple changes.
const KNOWN_KINDS = ["5xx", "latency"] as const;
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
  const targetStatusHeader = headers.get(`${prefix}-target-status`);
  if (targetStatusHeader !== null) {
    const n = Number.parseInt(targetStatusHeader, 10);
    if (Number.isFinite(n)) attrs.targetStatus = n;
  }

  const latencyMsHeader = headers.get(`${prefix}-latency-ms`);
  if (latencyMsHeader !== null) {
    const n = Number.parseFloat(latencyMsHeader);
    if (Number.isFinite(n)) attrs.latencyMs = n;
  }

  const traceId = headers.get(`${prefix}-trace-id`) ?? undefined;
  if (traceId) attrs.traceId = traceId;

  return { attrs, traceId };
}
