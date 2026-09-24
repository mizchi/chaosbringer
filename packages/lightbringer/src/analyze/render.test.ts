import { describe, expect, it } from "vitest";
import { buildSpanCpu, buildTraceRender, diffMetrics, type TraceEvent } from "./render";

describe("diffMetrics", () => {
  it("converts CDP second-counters to ms deltas", () => {
    const before = { RecalcStyleDuration: 0.01, LayoutDuration: 0.02, ScriptDuration: 0.1, RecalcStyleCount: 1, LayoutCount: 1, Nodes: 100 };
    const after = { RecalcStyleDuration: 0.015, LayoutDuration: 0.05, ScriptDuration: 0.3, RecalcStyleCount: 4, LayoutCount: 2, Nodes: 180 };
    const r = diffMetrics(before, after);
    expect(r.recalcStyleMs).toBe(5);
    expect(r.layoutMs).toBe(30);
    expect(r.scriptMs).toBe(200);
    expect(r.recalcStyleCount).toBe(3);
    expect(r.nodes).toBe(80);
  });
});

describe("buildTraceRender", () => {
  it("sums Paint/GPUTask durations inside the window only", () => {
    const events: TraceEvent[] = [
      { name: "Paint", ph: "X", ts: 1500, dur: 2000 },
      { name: "GPUTask", ph: "X", ts: 1600, dur: 4000 },
      { name: "Paint", ph: "X", ts: 9000, dur: 1000 }, // outside
    ];
    const r = buildTraceRender(events, 1000, 2000);
    expect(r.paintCount).toBe(1);
    expect(r.paintMs).toBe(2);
    expect(r.gpuMs).toBe(4);
  });
});

describe("buildSpanCpu", () => {
  it("aggregates long tasks that start inside the window", () => {
    const cpu = buildSpanCpu(
      { startEpochMs: 1000, endEpochMs: 2000 },
      [
        { epochStart: 1100, duration: 60 },
        { epochStart: 1500, duration: 120 },
        { epochStart: 5000, duration: 999 }, // outside
      ],
      [{ epochStart: 1200, duration: 200, blocking: 150 }],
    );
    expect(cpu.longTaskCount).toBe(2);
    expect(cpu.blockingMs).toBe(180);
    expect(cpu.maxLongTaskMs).toBe(120);
    expect(cpu.maxLoafBlockingMs).toBe(150);
  });
});
