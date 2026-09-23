// Memory analysis. Per-step memory load from CDP Performance.getMetrics gauges
// (diffMemory) and cross-step leak detection across the repeats of a measureRepeat
// (buildTrends). Pure: consumes plain metric maps and {name, memory} records.
import { round } from "./util";

/**
 * Memory load a span incurs, from CDP Performance.getMetrics gauges (always on,
 * no trace needed). This is per-step memory *load* — how much a step grows the JS
 * heap and what it retains (DOM / listeners / documents) — in the same
 * "resource consumed per step" model as cpu / network / render. It is NOT
 * heap-snapshot leak detection: the retained-object graph (which object holds
 * what) is out of scope. The leak *signal* here is a delta that stays positive
 * across repeated runs of the same step (heap / listeners / documents climbing).
 *
 * Byte-level binary / GPU memory is NOT available here: CDP getMetrics has no
 * byte counter for off-heap memory (only disabled-by-default-memory-infra trace
 * dumps do, which are heavy and unreliable headless), and JSHeapUsedSize counts
 * only on-heap JS objects — an ArrayBuffer / typed-array / wasm backing store is
 * off-heap and does NOT move it. The closest available proxy for buffer memory is
 * arrayBuffers, a *count* of live ArrayBuffers (climbing ⇒ buffers being retained,
 * e.g. GPU textures / staging buffers / wasm), not their byte size.
 */
export interface SpanMemory {
  /** on-heap JS in use at span end (MB, absolute; excludes off-heap buffer backing stores) */
  jsHeapUsedMB: number;
  /** on-heap JS growth during the span (MB; sustained positive across repeats ⇒ leak) */
  jsHeapDeltaMB: number;
  /** count of live ArrayBuffers at span end (NOT bytes; a climbing count ⇒ buffer leak) */
  arrayBuffers: number;
  /** total DOM nodes retained at span end (absolute; the DOM size, not the delta) */
  domNodes: number;
  /** event listeners retained at span end (absolute; climbing every step ⇒ listener leak) */
  jsEventListeners: number;
  /** net event listeners added during the span */
  listenersDelta: number;
  /** net documents added during the span (climbing ⇒ detached-document leak) */
  documentsDelta: number;
}

/**
 * Growth of a memory metric across repeated runs of the SAME step (the `#0..#N`
 * spans emitted by measureRepeat). Per-step deltas are GC-noisy, but a value that
 * climbs monotonically every time you repeat the same operation is the real leak
 * signal — and it stays inside one scenario, so it isn't the out-of-scope
 * cross-scenario analysis. Most trustworthy under PERF_MEM=1 (retained-only).
 */
export interface MemoryTrend {
  /** the repeated step name (the shared prefix of the `#i` spans) */
  name: string;
  /** number of repeats */
  count: number;
  /** which memory gauge: jsHeapUsedMB | jsEventListeners | domNodes | arrayBuffers */
  metric: string;
  /** the metric's absolute value at the end of each repeat */
  values: number[];
  /** last - first */
  growth: number;
  /** growth per repeat */
  perStep: number;
  /** value never (meaningfully) dropped across the repeats */
  monotonic: boolean;
  /** monotonic AND grew past the metric's floor — flagged as a likely leak */
  leak: boolean;
}

const BYTES_PER_MB = 1024 * 1024;

/** CDP Performance.getMetrics memory gauges -> per-step memory load. */
export function diffMemory(
  before: Record<string, number>,
  after: Record<string, number>,
): SpanMemory {
  const d = (k: string) => (after[k] ?? 0) - (before[k] ?? 0);
  const a = (k: string) => after[k] ?? 0;
  return {
    jsHeapUsedMB: round(a("JSHeapUsedSize") / BYTES_PER_MB),
    jsHeapDeltaMB: round(d("JSHeapUsedSize") / BYTES_PER_MB),
    arrayBuffers: a("ArrayBufferContents"),
    domNodes: a("Nodes"),
    jsEventListeners: a("JSEventListeners"),
    listenersDelta: d("JSEventListeners"),
    documentsDelta: d("Documents"),
  };
}

/** Memory gauges tracked for cross-step growth; floor = min growth to call a leak. */
const TREND_METRICS: Array<{
  key: string;
  get: (m: SpanMemory) => number;
  floor: number;
}> = [
  { key: "jsHeapUsedMB", get: (m) => m.jsHeapUsedMB, floor: 2 },
  { key: "jsEventListeners", get: (m) => m.jsEventListeners, floor: 10 },
  { key: "domNodes", get: (m) => m.domNodes, floor: 50 },
  { key: "arrayBuffers", get: (m) => m.arrayBuffers, floor: 5 },
];

const repeatIndex = (name: string): number => {
  const m = /#(\d+)$/.exec(name);
  return m ? Number(m[1]) : -1;
};

/**
 * Detect monotonic memory growth across the `${name}#${i}` spans of a measureRepeat.
 * A metric is reported only when it grows past its floor; `leak` is set when that
 * growth is also monotonic (the value didn't meaningfully drop between repeats).
 * Input is narrowed to {name, memory} so this stays decoupled from the full
 * SpanReport contract.
 */
export function buildTrends(
  spans: Array<{ name: string; memory: SpanMemory }>,
): MemoryTrend[] {
  const groups = new Map<string, Array<{ name: string; memory: SpanMemory }>>();
  for (const s of spans) {
    const m = /^(.*)#(\d+)$/.exec(s.name);
    if (!m) continue;
    const prefix = m[1];
    (groups.get(prefix) ?? groups.set(prefix, []).get(prefix)!).push(s);
  }
  const trends: MemoryTrend[] = [];
  for (const [prefix, group] of groups) {
    if (group.length < 3) continue; // too few points to call a trend
    group.sort((a, b) => repeatIndex(a.name) - repeatIndex(b.name));
    for (const tm of TREND_METRICS) {
      const values = group.map((s) => round(tm.get(s.memory)));
      const growth = round(values[values.length - 1] - values[0]);
      // Worst single backslide. A real leak ramps up with only minor dips; a
      // value that bounces (e.g. maplibre's tile buffers, reclaimed by GC between
      // steps) has a backslide comparable to or larger than its net growth, even
      // when the endpoints happen to be higher. Require the net climb to dominate
      // the jitter — otherwise the +N is noise, not retention.
      let maxDrop = 0;
      let maxStepInc = 0;
      let incCount = 0;
      for (let i = 1; i < values.length; i++) {
        const delta = values[i] - values[i - 1];
        if (delta > 0) {
          incCount += 1;
          if (delta > maxStepInc) maxStepInc = delta;
        } else if (-delta > maxDrop) {
          maxDrop = -delta;
        }
      }
      const monotonic = maxDrop <= 0.1 * Math.abs(growth);
      // A leak grows step over step. Three things must hold:
      // - the net climb dominates the worst backslide (not a bouncing series, e.g.
      //   maplibre tile buffers reclaimed by GC),
      // - the growth is a meaningful fraction of the baseline, not just past an
      //   absolute floor (a +8 churn on a 1500 baseline isn't a leak; 30→180 is),
      // - the growth is DISTRIBUTED across steps, not one jump (a single tile batch
      //   loaded on the last pan, 44→44→44→44→125, is a one-off, not retention).
      const rel = values[0] > 0 ? growth / values[0] : Infinity;
      // and the back half must keep growing — a series that ramps then plateaus
      // (maplibre warming its tile cache: 11→21→27→27.6) is allocation that
      // levels off, not an unbounded leak.
      const mid = Math.floor(values.length / 2);
      const secondHalfGrowth = values[values.length - 1] - values[mid];
      const distributed =
        maxStepInc <= 0.6 * growth &&
        incCount >= Math.ceil((values.length - 1) / 2) &&
        secondHalfGrowth >= 0.25 * growth;
      const leak =
        growth >= tm.floor && growth > 2 * maxDrop && rel >= 0.2 && distributed;
      if (!leak) continue; // only surface sustained, distributed, non-plateauing ramps
      trends.push({
        name: prefix,
        count: group.length,
        metric: tm.key,
        values,
        growth,
        perStep: round(growth / (group.length - 1)),
        monotonic,
        leak,
      });
    }
  }
  return trends;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

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
}
