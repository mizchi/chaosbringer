// Conversion layer: User Timing (performance.measure) -> OpenTelemetry-style span.
//
// The measurement primitive is the browser-standard Performance API. This layer
// only converts collected PerformanceMeasure entries into an OTel span shape
// (name / id / parent / time / attributes). It does not send anything to a
// server; it is the point where an OTLP exporter would later plug in.
//
// User Timing is flat (no parent/child), so the parent is inferred from time
// containment. Asynchronous, overlapping spans cannot be disambiguated exactly
// (known limitation).

export type AttrValue = string | number | boolean;

/** Equivalent to performance.getEntriesByType("measure"). startTime is ms relative to timeOrigin. */
export interface PerfMeasureLike {
  name: string;
  startTime: number;
  duration: number;
  detail?: unknown;
}

/** Local OTel span representation (subset of OTLP). start/end are epoch ms. */
export interface OtelSpan {
  name: string;
  spanId: string;
  parentSpanId?: string;
  startUnixMs: number;
  endUnixMs: number;
  durationMs: number;
  attributes: Record<string, AttrValue>;
}

function extractAttributes(detail: unknown): Record<string, AttrValue> {
  if (typeof detail === "object" && detail !== null && "attributes" in detail) {
    const a = (detail as { attributes?: unknown }).attributes;
    if (typeof a === "object" && a !== null) {
      return { ...(a as Record<string, AttrValue>) };
    }
  }
  return {};
}

/**
 * Convert PerformanceMeasure entries into OTel spans.
 * - Times are shifted to epoch ms by adding timeOrigin (so they correlate with
 *   the collector's network / CPU windows).
 * - spanId is assigned deterministically by input order (for tests / correlation).
 * - parentSpanId is inferred as the smallest span that strictly contains this one.
 */
export function toOtelSpans(
  measures: PerfMeasureLike[],
  timeOrigin: number,
): OtelSpan[] {
  const spans: OtelSpan[] = measures.map((m, i) => ({
    name: m.name,
    spanId: `s${i}`,
    startUnixMs: timeOrigin + m.startTime,
    endUnixMs: timeOrigin + m.startTime + m.duration,
    durationMs: m.duration,
    attributes: extractAttributes(m.detail),
  }));

  for (const child of spans) {
    let best: OtelSpan | undefined;
    for (const cand of spans) {
      if (cand === child) continue;
      const contains =
        cand.startUnixMs <= child.startUnixMs &&
        cand.endUnixMs >= child.endUnixMs;
      const strictlyLarger =
        cand.endUnixMs - cand.startUnixMs > child.endUnixMs - child.startUnixMs;
      if (contains && strictlyLarger) {
        if (
          !best ||
          cand.endUnixMs - cand.startUnixMs < best.endUnixMs - best.startUnixMs
        ) {
          best = cand;
        }
      }
    }
    if (best) child.parentSpanId = best.spanId;
  }

  return spans;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("toOtelSpans", () => {
    it("shifts startTime to epoch ms by adding timeOrigin", () => {
      const out = toOtelSpans(
        [{ name: "a", startTime: 100, duration: 50 }],
        1_000_000,
      );
      expect(out[0].startUnixMs).toBe(1_000_100);
      expect(out[0].endUnixMs).toBe(1_000_150);
      expect(out[0].durationMs).toBe(50);
    });

    it("extracts detail.attributes into span attributes", () => {
      const out = toOtelSpans(
        [
          {
            name: "fetch",
            startTime: 0,
            duration: 10,
            detail: { attributes: { url: "/stats", count: 3, cached: false } },
          },
        ],
        0,
      );
      expect(out[0].attributes).toEqual({
        url: "/stats",
        count: 3,
        cached: false,
      });
    });

    it("leaves attributes empty when detail is absent", () => {
      const out = toOtelSpans([{ name: "a", startTime: 0, duration: 1 }], 0);
      expect(out[0].attributes).toEqual({});
    });

    it("infers the smallest containing span as parent", () => {
      // outer[0,100] > mid[10,90] > leaf[20,30]
      const out = toOtelSpans(
        [
          { name: "outer", startTime: 0, duration: 100 },
          { name: "mid", startTime: 10, duration: 80 },
          { name: "leaf", startTime: 20, duration: 10 },
        ],
        0,
      );
      const byName = Object.fromEntries(out.map((s) => [s.name, s]));
      expect(byName.outer.parentSpanId).toBeUndefined();
      expect(byName.mid.parentSpanId).toBe(byName.outer.spanId);
      expect(byName.leaf.parentSpanId).toBe(byName.mid.spanId);
    });

    it("does not assign a parent to non-overlapping siblings", () => {
      const out = toOtelSpans(
        [
          { name: "x", startTime: 0, duration: 10 },
          { name: "y", startTime: 20, duration: 10 },
        ],
        0,
      );
      expect(out[0].parentSpanId).toBeUndefined();
      expect(out[1].parentSpanId).toBeUndefined();
    });
  });
}
