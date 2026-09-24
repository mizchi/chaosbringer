// Render / main-thread cost analysis. Turns CDP Performance.getMetrics deltas
// (style recalc / layout / script / nodes) and trace Paint/GPUTask events into a
// span's render breakdown, plus long-task/LoAF into its CPU breakdown.
// Pure: consumes plain metric maps, trace events, and in-page timing arrays.
import { inEpochWindow, round, type EpochWindow } from "./util";

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
  const inWindow = (epochStart: number) => inEpochWindow(epochStart, span);
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
