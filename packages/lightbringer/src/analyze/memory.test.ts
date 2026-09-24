import { describe, expect, it } from "vitest";
import { buildTrends, diffMemory, type SpanMemory } from "./memory";

const mem = (jsHeapUsedMB: number): SpanMemory => ({
  jsHeapUsedMB,
  jsHeapDeltaMB: 0,
  arrayBuffers: 0,
  domNodes: 0,
  jsEventListeners: 0,
  listenersDelta: 0,
  documentsDelta: 0,
});
const series = (name: string, vals: number[]) =>
  vals.map((v, i) => ({ name: `${name}#${i}`, memory: mem(v) }));

describe("diffMemory", () => {
  it("reports absolute heap and the per-step delta", () => {
    const r = diffMemory(
      { JSHeapUsedSize: 10 * 1024 * 1024, JSEventListeners: 5 },
      { JSHeapUsedSize: 14 * 1024 * 1024, JSEventListeners: 9, Nodes: 200 },
    );
    expect(r.jsHeapUsedMB).toBe(14);
    expect(r.jsHeapDeltaMB).toBe(4);
    expect(r.listenersDelta).toBe(4);
    expect(r.domNodes).toBe(200);
  });
});

describe("buildTrends", () => {
  it("flags a distributed monotonic climb as a leak", () => {
    const t = buildTrends(series("op", [30, 70, 120, 180]));
    const heap = t.find((x) => x.metric === "jsHeapUsedMB");
    expect(heap?.leak).toBe(true);
  });
  it("does not flag a ramp that plateaus (tile-cache warmup)", () => {
    const t = buildTrends(series("op", [11, 21, 27, 27.6]));
    expect(t.some((x) => x.metric === "jsHeapUsedMB")).toBe(false);
  });
  it("does not flag a bouncing series (GC-reclaimed buffers)", () => {
    const t = buildTrends(series("op", [100, 140, 100, 145]));
    expect(t.some((x) => x.metric === "jsHeapUsedMB")).toBe(false);
  });
  it("does not flag a single late jump", () => {
    const t = buildTrends(series("op", [44, 44, 44, 44, 125]));
    expect(t.some((x) => x.metric === "jsHeapUsedMB")).toBe(false);
  });
  it("ignores groups with fewer than three repeats", () => {
    expect(buildTrends(series("op", [10, 200])).length).toBe(0);
  });
});
