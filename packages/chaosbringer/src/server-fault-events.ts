/**
 * Parser for the `x-chaos-fault-*` response headers emitted by
 * `@mizchi/server-faults` when its `metadataHeader` option is set.
 * Pure function: no I/O, no Playwright surface — invoked from
 * `page.on('response', …)` once per response.
 */

const KNOWN_KINDS = new Set(["5xx", "latency"]);

export interface ServerFaultEventAttrs {
  kind: "5xx" | "latency";
  path: string;
  method: string;
  targetStatus?: number;
  latencyMs?: number;
  traceId?: string;
}

export interface ParsedServerFault {
  attrs: ServerFaultEventAttrs;
  traceId?: string;
}

export function parseServerFaultHeaders(
  headers: Headers,
  prefix: string,
): ParsedServerFault | null {
  const kind = headers.get(`${prefix}-kind`);
  if (!kind || !KNOWN_KINDS.has(kind)) return null;

  const path = headers.get(`${prefix}-path`);
  const method = headers.get(`${prefix}-method`);
  if (!path || !method) return null;

  const attrs: ServerFaultEventAttrs = {
    kind: kind as "5xx" | "latency",
    path,
    method,
  };

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
