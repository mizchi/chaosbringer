import type { Page } from "playwright";
import type { OtelSpan } from "./otel";
import type { SpanNetwork, NetworkReport } from "./analyze/network";
import type { SpanRender, SpanCpu } from "./analyze/render";
import type { SpanMemory, MemoryTrend } from "./analyze/memory";
import type { Coverage } from "./analyze/coverage";
import type {
  VitalSample,
  SpanInteraction,
  SpanFrames,
} from "./analyze/vitals";

// ---------------------------------------------------------------------------
// Report types (the contract layer). The per-domain fragment types
// (SpanNetwork / SpanCpu / SpanRender / SpanMemory / ...) live in ./analyze;
// the composite report types that tie them together live here, along with the
// budget gate that reads them.
// ---------------------------------------------------------------------------

/**
 * Per-span budget. Each field is an upper bound; the median gate (and optional
 * inline assert) fails when the measured value exceeds it. scriptMs is the most
 * reliable bound (±1ms); duration/blocking are noisier — gate them on the median.
 */
export interface Budget {
  durationMs?: number;
  scriptMs?: number;
  blockingMs?: number;
  encodedKB?: number;
  requestCount?: number;
  waves?: number;
  busyMs?: number;
  layoutCount?: number;
  /** upper bound on style-recalc time (ms) — the selector-match cost of a step */
  recalcStyleMs?: number;
  /** upper bound on how many elements had style recalculated */
  recalcStyleCount?: number;
  nodes?: number;
  /** upper bound on bytes loaded from third-party origins */
  thirdPartyKB?: number;
  /** upper bound on request count to third-party origins */
  thirdPartyRequestCount?: number;
  /** paint metrics are only present with PERF_TRACE=1; the gate is a no-op otherwise */
  paintMs?: number;
  paintCount?: number;
  /** GPU task time (ms); only present with PERF_TRACE=1, gate is a no-op otherwise */
  gpuMs?: number;
  /** upper bound on JS heap in use at span end (MB) */
  jsHeapUsedMB?: number;
  /** upper bound on JS heap growth during the span (MB) — catches per-step leaks */
  jsHeapDeltaMB?: number;
  /** upper bound on net event listeners added during the span — catches listener leaks */
  listenersDelta?: number;
  /** upper bound on the worst interaction latency in the span (per-step INP, ms) */
  interactionMs?: number;
  /** upper bound on dropped frames in the span (animation jank) */
  droppedFrames?: number;
  /** upper bound on the worst frame gap in the span (ms) */
  longestFrameMs?: number;
}

export interface SpanReport {
  name: string;
  /** measured time from action start until settle (ms) */
  durationMs: number;
  /** true if settle hit PERF_SETTLE_TIMEOUT (durationMs is then unreliable) */
  capped: boolean;
  network: SpanNetwork;
  cpu: SpanCpu;
  render: SpanRender;
  memory: SpanMemory;
  /** responsiveness of interactions in the span (per-step INP); absent if none */
  interaction?: SpanInteraction;
  /** frame cadence during the span (animation smoothness); absent if too few frames */
  frames?: SpanFrames;
  /** span window in trace clock (monotonic μs). Used by the drilldown script. */
  traceWindowUs: [number, number];
  /** declared budget, if any (carried into the report so the median gate can read it) */
  budget?: Budget;
}

/**
 * A User Timing (performance.measure) emitted from app code, converted to an OTel
 * span. Sits inside the operation-unit SpanReport to show which implementation
 * region spent the network / CPU.
 */
export interface AppSpanReport extends OtelSpan {
  network: SpanNetwork;
  cpu: SpanCpu;
}

/** Upper bounds on page-global web-vitals (gated on the median, like span budgets). */
export interface VitalsBudget {
  LCP?: number;
  INP?: number;
  CLS?: number;
  TTFB?: number;
  FCP?: number;
}

export interface PerfReport {
  title: string;
  url: string;
  vitals: Record<string, VitalSample>;
  /** declared web-vitals budget, if any (carried so the median gate can read it) */
  vitalsBudget?: VitalsBudget;
  spans: SpanReport[];
  /** spans derived from app-code measures (OTel shape) */
  appSpans: AppSpanReport[];
  /** scenario-wide network total */
  network: NetworkReport;
  /** page CSS/DOM capacity — the "why is style recalc expensive" denominator */
  css?: CssProfile;
  /** JS/CSS coverage across the scenario (PERF_COV=1) — chunk usage / dead code */
  coverage?: Coverage;
  /** image over-fetch + uncompressed-resource analysis */
  media?: MediaReport;
  /** render-blocking resources in <head> (delay first paint / LCP) */
  renderBlocking?: RenderBlocking;
  /** WebGL renderer string; "SwiftShader" means software GL (GPU numbers are fake) */
  glRenderer?: string;
  /** uncaught page errors during measurement; non-empty means results are suspect */
  pageErrors?: string[];
  /** true if the in-page collector never ran (e.g. page.setContent without a goto) */
  collectorMissing?: boolean;
  /** memory growth across repeated steps (from measureRepeat); leak signal */
  trends?: MemoryTrend[];
  tracePath?: string;
}

/**
 * Page CSS/DOM capacity. Style recalc cost is roughly O(elements × selectors that
 * survive fast-rejection), so a big DOM crossed with a big stylesheet is the
 * structural cause of an expensive recalc. This is the denominator; PERF_CSS=1 +
 * the drilldown's selector stats are the per-selector numerator.
 */
export interface CssProfile {
  styleSheets: number;
  /** total style rules across all same-origin sheets (recurses into @media) */
  cssRules: number;
  /** total selectors (comma-split selectorText) — the match-cost multiplier */
  selectors: number;
  /** live DOM element count */
  domNodes: number;
}

/**
 * Image / media weight. Two wins that a byte count alone misses: images shipped
 * far larger than they're displayed (over-fetch — a 2000px image in a 256px box),
 * and large text resources served with little/no compression. From Resource
 * Timing (encoded/decoded sizes) + DOM intrinsic-vs-rendered dimensions.
 */
export interface MediaReport {
  imageCount: number;
  imageKB: number;
  /** images whose intrinsic pixels far exceed their rendered (CSS×DPR) pixels */
  oversized: Array<{
    url: string;
    naturalPx: string;
    renderedPx: string;
    /** intrinsic area / rendered area (≥4 means ≥2× too big per dimension) */
    overFetch: number;
    kb: number;
  }>;
  /** large compressible resources shipped ~uncompressed (decoded ≈ encoded) */
  uncompressed: Array<{ url: string; kb: number; ratio: number; type: string }>;
}

/**
 * Render-blocking resources in <head>: stylesheets (the parser waits for CSSOM
 * before first paint) and parser-blocking classic scripts (no async/defer, not a
 * module). These push out first paint / LCP. Pair with the LCP attribution
 * sub-parts (TTFB / load delay / load duration / render delay) to see whether LCP
 * is server-bound, resource-bound, or render-bound.
 */
export interface RenderBlocking {
  stylesheets: string[];
  scripts: string[];
}

/** Strategy that waits until the page has settled after an action. */
export type Settle = (page: Page) => Promise<void>;

/** Map a budget field to the actual value on a span report. */
const BUDGET_METRIC: Record<keyof Budget, (s: SpanReport) => number> = {
  durationMs: (s) => s.durationMs,
  scriptMs: (s) => s.render.scriptMs,
  blockingMs: (s) => s.cpu.blockingMs,
  encodedKB: (s) => s.network.encodedKB,
  requestCount: (s) => s.network.requestCount,
  waves: (s) => s.network.waves,
  busyMs: (s) => s.network.busyMs,
  layoutCount: (s) => s.render.layoutCount,
  recalcStyleMs: (s) => s.render.recalcStyleMs,
  recalcStyleCount: (s) => s.render.recalcStyleCount,
  nodes: (s) => s.render.nodes,
  thirdPartyKB: (s) => s.network.thirdParty.encodedKB,
  thirdPartyRequestCount: (s) => s.network.thirdParty.requestCount,
  paintMs: (s) => s.render.paintMs ?? 0,
  paintCount: (s) => s.render.paintCount ?? 0,
  gpuMs: (s) => s.render.gpuMs ?? 0,
  jsHeapUsedMB: (s) => s.memory.jsHeapUsedMB,
  jsHeapDeltaMB: (s) => s.memory.jsHeapDeltaMB,
  listenersDelta: (s) => s.memory.listenersDelta,
  interactionMs: (s) => s.interaction?.maxDurationMs ?? 0,
  droppedFrames: (s) => s.frames?.droppedFrames ?? 0,
  longestFrameMs: (s) => s.frames?.longestFrameMs ?? 0,
};

/** Budget violations on a single run (actual > budget). */
export function checkBudgets(report: PerfReport): string[] {
  const out: string[] = [];
  for (const s of report.spans) {
    if (!s.budget) continue;
    for (const k of Object.keys(s.budget) as (keyof Budget)[]) {
      const limit = s.budget[k];
      if (limit == null) continue;
      const actual = BUDGET_METRIC[k](s);
      if (actual > limit) {
        out.push(`${s.name}.${k}=${actual} > budget ${limit}`);
      }
    }
  }
  if (report.vitalsBudget) {
    for (const k of Object.keys(report.vitalsBudget) as (keyof VitalsBudget)[]) {
      const limit = report.vitalsBudget[k];
      const actual = report.vitals[k]?.value;
      if (limit != null && actual != null && actual > limit) {
        out.push(`vitals.${k}=${actual} > budget ${limit}`);
      }
    }
  }
  return out;
}
