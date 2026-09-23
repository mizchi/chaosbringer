// Render / main-thread cost analysis. Turns CDP Performance.getMetrics deltas
// (style recalc / layout / script / nodes) and trace Paint/GPUTask events into a
// span's render breakdown, plus long-task/LoAF into its CPU breakdown.
// Pure: consumes plain metric maps, trace events, and in-page timing arrays.
import { round, type EpochWindow } from "./util";

/**
 * Render breakdown of a span (DOM change -> style recalc -> layout -> paint).
 * style/layout/script come from CDP Performance.getMetrics cumulative counters.
 * paint/GPU are filled from the trace when PERF_TRACE=1 (undefined otherwise).
 */
export interface SpanRender {
  recalcStyleCount: number;
  recalcStyleMs: number;
  layoutCount: number;
  layoutMs: number;
  /** net DOM nodes added during the span (CDP Nodes delta) — the driver of huge-DOM
   * style/layout cost. Not a memory metric; a render-cost cause. */
  nodes: number;
  /** JS execution time in the span (ms, CDP metric; distinct from cpu.blockingMs) */
  scriptMs: number;
  paintCount?: number;
  paintMs?: number;
  gpuMs?: number;
}

/** CPU breakdown of a span (CPU bottleneck analysis). */
export interface SpanCpu {
  longTaskCount: number;
  /** total long task time (ms), approx. main-thread blocking */
  blockingMs: number;
  maxLongTaskMs: number;
  loafCount: number;
  /** blockingDuration of the heaviest LoAF (ms) */
  maxLoafBlockingMs: number;
}

export interface TraceEvent {
  name?: string;
  ph?: string;
  ts?: number;
  dur?: number;
}

/** CDP Performance.getMetrics cumulative counter delta -> render cost */
export function diffMetrics(
  before: Record<string, number>,
  after: Record<string, number>,
): SpanRender {
  const d = (k: string) => (after[k] ?? 0) - (before[k] ?? 0);
  return {
    recalcStyleCount: d("RecalcStyleCount"),
    recalcStyleMs: round(d("RecalcStyleDuration") * 1000),
    layoutCount: d("LayoutCount"),
    layoutMs: round(d("LayoutDuration") * 1000),
    nodes: d("Nodes"),
    scriptMs: round(d("ScriptDuration") * 1000),
  };
}

/**
 * Aggregate Paint count/time and GPU task time within a span window (monotonic μs).
 * The span window comes from getMetrics Timestamp, the same clock as trace ts, so
 * no conversion is needed.
 */
export function buildTraceRender(
  events: TraceEvent[],
  startUs: number,
  endUs: number,
): Pick<SpanRender, "paintCount" | "paintMs" | "gpuMs"> {
  let paintCount = 0;
  let paintMs = 0;
  let gpuMs = 0;
  for (const e of events) {
    if (e.ph !== "X" || e.ts == null || e.dur == null) continue;
    if (e.ts < startUs || e.ts > endUs) continue;
    if (e.name === "Paint") {
      paintCount += 1;
      paintMs += e.dur / 1000;
    } else if (e.name === "GPUTask") {
      gpuMs += e.dur / 1000;
    }
  }
  return { paintCount, paintMs: round(paintMs), gpuMs: round(gpuMs) };
}

export function buildSpanCpu(
  span: EpochWindow,
  longTasks: Array<{ epochStart: number; duration: number }>,
  loaf: Array<{ epochStart: number; duration: number; blocking: number }>,
): SpanCpu {
  const inWindow = (epochStart: number) =>
    epochStart >= span.startEpochMs && epochStart <= span.endEpochMs;
  const lt = longTasks.filter((t) => inWindow(t.epochStart));
  const lf = loaf.filter((l) => inWindow(l.epochStart));
  return {
    longTaskCount: lt.length,
    blockingMs: round(lt.reduce((a, t) => a + t.duration, 0)),
    maxLongTaskMs: round(lt.reduce((a, t) => Math.max(a, t.duration), 0)),
    loafCount: lf.length,
    maxLoafBlockingMs: round(lf.reduce((a, l) => Math.max(a, l.blocking), 0)),
  };
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

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
}
