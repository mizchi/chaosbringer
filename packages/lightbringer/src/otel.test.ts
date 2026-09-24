import { describe, expect, it } from "vitest";
import { toOtelSpans } from "./otel";

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
