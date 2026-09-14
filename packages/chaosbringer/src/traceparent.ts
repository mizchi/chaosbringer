/**
 * W3C traceparent parsing, for the route handler that honours an incoming
 * header and still wants to hand `traceId` / `spanId` to the consumer hook.
 */

/**
 * Parse a W3C traceparent header. Returns `null` if the value is malformed.
 * Used by the route handler when honouring an incoming traceparent so we
 * can still pass `traceId` / `spanId` to the consumer hook.
 *
 * Format: `00-{trace-id-32hex}-{span-id-16hex}-{flags-2hex}`.
 *
 * Exported for testing — consumers should not parse traceparents
 * themselves.
 */
export function parseTraceparent(value: string): { traceId: string; spanId: string } | null {
  // version-traceId-spanId-flags
  const m = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i.exec(value.trim());
  if (!m) return null;
  return { traceId: m[2].toLowerCase(), spanId: m[3].toLowerCase() };
}
