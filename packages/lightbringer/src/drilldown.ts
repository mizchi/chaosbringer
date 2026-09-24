// Trace drilldown of one span: which subsystem / function / selector / domain
// spent the span's time. Pure; scripts/drilldown.mjs reads the report and the
// trace file and prints formatDrilldown(analyseDrilldown(...)).
//
// Needs a trace captured with the span (PERF_TRACE=1): the span's
// traceWindowUs is matched against the trace events' ts.
import { round } from "./analyze/util";
import { domainOfUrl, stripOrigin, type InitiatorStat } from "./analyze/network";
import type { TraceEvent } from "./analyze/render";
import type { SpanReport } from "./report-types";

/** The Chrome trace event fields the drilldown reads. */
export interface DrilldownTraceEvent extends TraceEvent {
  // Trace args vary per event name; each reader below narrows what it needs.
  args?: any;
}

/** The span fields the drilldown reads (a SpanReport satisfies it). */
export type DrilldownSpan = Pick<SpanReport, "durationMs" | "traceWindowUs"> & {
  cpu: Pick<SpanReport["cpu"], "blockingMs">;
  render: Pick<SpanReport["render"], "scriptMs"> &
    Partial<Pick<SpanReport["render"], "gpuMs" | "recalcStyleMs">>;
  network?: Partial<Pick<SpanReport["network"], "requestCount" | "waves">> & {
    byInitiator?: InitiatorStat[];
  };
};

export type FrameKind = "app" | "harness" | "native";

export interface NamedTotal {
  name: string;
  /** summed duration, rounded to 0.1 ms */
  totalMs: number;
  count: number;
}

export interface SelfFrame {
  /** "functionName  url:line" */
  key: string;
  selfMs: number;
  kind: FrameKind;
  /** first/third party for app frames, when the page domain is known */
  party: "first" | "third" | null;
}

export interface SelectorCost {
  selector: string;
  /** summed match time (μs) */
  us: number;
  attempts: number;
  rejects: number;
  matches: number;
}

export interface DrilldownAnalysis {
  span: DrilldownSpan;
  topN: number;
  /** RunTask events in the window (main-thread tasks) */
  tasks: { totalMs: number; count: number; /** tasks >= 50 ms, longest first */ longTasksMs: number[] };
  /** event-name breakdown (which subsystem), RunTask excluded; top 12 */
  byEventName: NamedTotal[];
  /** FunctionCall / EvaluateScript / v8.compile totals (include children); top N */
  byFunction: { key: string; totalMs: number; count: number }[];
  /** own cost per frame from the V8 CPU profiler samples in the window */
  self: {
    ranked: SelfFrame[];
    byKind: Record<FrameKind, number>;
    byParty: { first: number; third: number };
    /** registrable domain of the page, or null when unknown */
    firstPartyDomain: string | null;
  };
  /** third-party app self time rolled up per script domain */
  thirdPartyByDomain: { domain: string; selfMs: number }[];
  /** GPU process work (raster / decode / paint off the main thread) */
  gpu: { gpuTaskMs: number; ranked: NamedTotal[] };
  /** who issued the span's requests (from the report; needs no trace) */
  initiators: InitiatorStat[];
  imageDecode: { ms: number; count: number };
  /** per-selector match cost (SelectorStats, PERF_CSS=1); undefined when absent */
  selectors?: {
    count: number;
    totalUs: number;
    /** slowest by match time; top N */
    slowest: SelectorCost[];
    /** attempted but never matched, most attempts first; top N */
    wasteful: SelectorCost[];
  };
}

/** Default number of rows in the function / self / selector rankings. */
export const DRILLDOWN_TOP_N = 15;

const shorten = (url: string): string => stripOrigin(url, 70, "none");

/**
 * Known harness frames: Playwright's injected actionability / visibility
 * helpers (no script URL) and lightbringer's own in-page collector. Used to
 * separate measurement overhead from the app's own self time.
 */
export const HARNESS_FRAME_NAMES: ReadonlySet<string> = new Set([
  "getComputedStyle",
  "getElementComputedStyle",
  "isElementStyleVisibilityVisible",
  "isVisible",
  "elementState",
  "processElement",
  "getCSSContent",
  "visit",
  "oneLine",
  "generateSelector",
  "querySelectorAll",
  "ariaSnapshot",
  "getTextAlternativeInternal",
  "getExplicitAriaRole",
  "getImplicitAriaRole",
  "belongsToDisplayNoneOrAriaHiddenOrNonSlotted",
  "InjectedScript",
  "browserCollector",
  "drainLongTask",
  "drainLoaf",
  "drainMeasure",
]);

/** V8 synthetic frames: idle / GC time, not JS anyone wrote. */
const SYNTHETIC_FRAMES = new Set(["(idle)", "(program)", "(garbage collector)", "(root)"]);

const GPU_NAMES = new Set(["GPUTask", "RasterTask", "ImageDecodeTask", "Rasterize", "RasterFinishedTask"]);
const DECODE_NAMES = new Set(["Decode Image", "ImageDecodeTask", "Decode LazyPixelRef"]);

function rankTotals(m: Map<string, { totalMs: number; count: number }>): NamedTotal[] {
  return [...m.entries()]
    .map(([name, v]) => ({ name, totalMs: round(v.totalMs), count: v.count }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

function addTotal(m: Map<string, { totalMs: number; count: number }>, key: string, ms: number) {
  const cur = m.get(key) ?? { totalMs: 0, count: 0 };
  cur.totalMs += ms;
  cur.count += 1;
  m.set(key, cur);
}

/**
 * Analyse the trace events inside `span`'s window. `pageUrl` (the report's
 * url) decides which app frames are first- vs third-party.
 */
export function analyseDrilldown(
  span: DrilldownSpan,
  events: readonly DrilldownTraceEvent[],
  { pageUrl, topN = DRILLDOWN_TOP_N }: { pageUrl?: string; topN?: number } = {},
): DrilldownAnalysis {
  const [startUs, endUs] = span.traceWindowUs;
  const firstPartyDomain = pageUrl ? domainOfUrl(pageUrl) : null;

  // Complete ("X") events that start inside the window.
  const inWindow = events.filter(
    (e) => e.ph === "X" && e.ts != null && e.ts >= startUs && e.ts <= endUs,
  );

  const taskDurs = inWindow.filter((e) => e.name === "RunTask").map((e) => e.dur! / 1000);
  const tasks = {
    totalMs: taskDurs.reduce((a, d) => a + d, 0),
    count: taskDurs.length,
    longTasksMs: taskDurs.filter((d) => d >= 50).sort((a, b) => b - a),
  };

  // Which subsystem is heavy (RunTask excluded: it is the container of the rest).
  const byName = new Map<string, { totalMs: number; count: number }>();
  for (const e of inWindow) {
    if (!e.name || e.name === "RunTask" || e.dur == null) continue;
    addTotal(byName, e.name, e.dur / 1000);
  }
  const byEventName = rankTotals(byName).slice(0, 12);

  const byFn = new Map<string, { totalMs: number; count: number }>();
  for (const e of inWindow) {
    const d = e.args?.data;
    if (!d) continue;
    let key: string;
    if (e.name === "FunctionCall") {
      const fn = d.functionName || "(anonymous)";
      const loc = d.url ? `${shorten(d.url)}:${d.lineNumber ?? "?"}` : "";
      key = `${fn}  ${loc}`;
    } else if (e.name === "EvaluateScript" || e.name === "v8.compile") {
      key = `(eval) ${shorten(d.url || "")}`;
    } else {
      continue;
    }
    addTotal(byFn, key, e.dur! / 1000);
  }
  const byFunction = rankTotals(byFn)
    .map(({ name, totalMs, count }) => ({ key: name, totalMs, count }))
    .slice(0, topN);

  // Self time from the V8 CPU profiler (disabled-by-default-v8.cpu_profiler).
  // ProfileChunk events carry incrementally-defined call-tree nodes plus a
  // sample stream (node id per sample) and timeDeltas (μs between samples).
  // Self time of a node = sum of timeDeltas for samples landing on it; unlike
  // the function totals above (which include children), it is each frame's
  // own cost. The sample clock runs over the whole trace, so every chunk is
  // walked and only samples inside the window are counted.
  type Frame = { label: string; kind: FrameKind; party: "first" | "third" | null; domain: string | null };
  const nodeFrame = new Map<number, Frame | null>();
  const selfByFrame = new Map<string, { ms: number; kind: FrameKind; party: Frame["party"] }>();
  const byKind: Record<FrameKind, number> = { app: 0, harness: 0, native: 0 };
  const byParty = { first: 0, third: 0 };
  const selfByDomain = new Map<string, number>();
  let profileStartUs: number | null = null;
  let cursorUs: number | null = null;

  for (const e of events) {
    if (e.name === "Profile" && e.args?.data?.startTime != null) {
      profileStartUs = e.args.data.startTime;
      cursorUs = profileStartUs;
    }
    if (e.name !== "ProfileChunk") continue;
    const cp = e.args?.data?.cpuProfile;
    if (!cp) continue;
    for (const n of cp.nodes ?? []) {
      const cf = n.callFrame ?? {};
      const fn: string = cf.functionName || "(anonymous)";
      if (SYNTHETIC_FRAMES.has(fn)) {
        nodeFrame.set(n.id, null);
        continue;
      }
      // app = has a script URL; harness = known injected/collector name; native = rest
      const kind: FrameKind = cf.url ? "app" : HARNESS_FRAME_NAMES.has(fn) ? "harness" : "native";
      const loc = cf.url ? `${shorten(cf.url)}:${(cf.lineNumber ?? 0) + 1}` : "";
      const domain = kind === "app" ? domainOfUrl(cf.url) : null;
      const party =
        kind === "app" && firstPartyDomain ? (domain === firstPartyDomain ? "first" : "third") : null;
      nodeFrame.set(n.id, { label: `${fn}  ${loc}`, kind, party, domain });
    }
    const samples: number[] = cp.samples ?? [];
    const deltas: number[] = e.args.data.timeDeltas ?? cp.timeDeltas ?? [];
    if (cursorUs == null) cursorUs = profileStartUs ?? startUs;
    for (let i = 0; i < samples.length; i++) {
      const dt = deltas[i] ?? 0;
      cursorUs += dt;
      if (cursorUs < startUs || cursorUs > endUs) continue;
      const frame = nodeFrame.get(samples[i]!);
      if (!frame) continue;
      const cur = selfByFrame.get(frame.label) ?? { ms: 0, kind: frame.kind, party: frame.party };
      cur.ms += dt / 1000;
      selfByFrame.set(frame.label, cur);
      byKind[frame.kind] += dt / 1000;
      if (frame.party) byParty[frame.party] += dt / 1000;
      if (frame.party === "third" && frame.domain) {
        selfByDomain.set(frame.domain, (selfByDomain.get(frame.domain) ?? 0) + dt / 1000);
      }
    }
  }
  const ranked = [...selfByFrame.entries()]
    .map(([key, v]) => ({ key, selfMs: round(v.ms), kind: v.kind, party: v.party }))
    .filter((r) => r.selfMs > 0)
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, topN);
  const thirdPartyByDomain = [...selfByDomain.entries()]
    .map(([domain, ms]) => ({ domain, selfMs: round(ms) }))
    .filter((r) => r.selfMs > 0)
    .sort((a, b) => b.selfMs - a.selfMs);

  // GPU process work units: a span can be cheap on CPU yet GPU-bound. These
  // come from the `gpu` + devtools.timeline.frame trace categories.
  const byGpu = new Map<string, { totalMs: number; count: number }>();
  let gpuTaskMs = 0;
  for (const e of inWindow) {
    if (!e.name || e.dur == null || !GPU_NAMES.has(e.name)) continue;
    addTotal(byGpu, e.name, e.dur / 1000);
    if (e.name === "GPUTask") gpuTaskMs += e.dur / 1000;
  }

  const imageDecode = { ms: 0, count: 0 };
  for (const e of inWindow) {
    if (e.dur == null || !DECODE_NAMES.has(e.name!)) continue;
    imageDecode.ms += e.dur / 1000;
    imageDecode.count += 1;
  }

  // SelectorStats (disabled-by-default-blink.debug, PERF_CSS=1) carry per-selector
  // match stats for each recalc. An event without ts is kept, as it always was.
  const selAgg = new Map<string, Omit<SelectorCost, "selector">>();
  for (const e of events) {
    if (e.name !== "SelectorStats") continue;
    if (e.ts != null && (e.ts < startUs || e.ts > endUs)) continue;
    const timings = e.args?.selector_stats?.selector_timings ?? [];
    for (const t of timings) {
      const cur = selAgg.get(t.selector) ?? { us: 0, attempts: 0, rejects: 0, matches: 0 };
      cur.us += t["elapsed (us)"] ?? 0;
      cur.attempts += t.match_attempts ?? 0;
      cur.rejects += t.fast_reject_count ?? 0;
      cur.matches += t.match_count ?? 0;
      selAgg.set(t.selector, cur);
    }
  }
  let selectors: DrilldownAnalysis["selectors"];
  if (selAgg.size > 0) {
    const all = [...selAgg.entries()].map(([selector, v]) => ({ selector, ...v }));
    selectors = {
      count: selAgg.size,
      totalUs: all.reduce((a, s) => a + s.us, 0),
      slowest: [...all].sort((a, b) => b.us - a.us).slice(0, topN),
      // attempted on every recalc but never matched: dead weight
      wasteful: all
        .filter((s) => s.matches === 0 && s.attempts > 0)
        .sort((a, b) => b.attempts - a.attempts)
        .slice(0, topN),
    };
  }

  return {
    span,
    topN,
    tasks,
    byEventName,
    byFunction,
    self: { ranked, byKind, byParty, firstPartyDomain },
    thirdPartyByDomain,
    gpu: { gpuTaskMs, ranked: rankTotals(byGpu) },
    initiators: span.network?.byInitiator ?? [],
    imageDecode,
    selectors,
  };
}

/**
 * The report scripts/drilldown.mjs prints: each entry is one console.log call
 * (some start with "\n" to open a section).
 */
export function formatDrilldown(
  a: DrilldownAnalysis,
  { slug, spanName }: { slug: string; spanName: string },
): string[] {
  const out: string[] = [];
  const { span, topN } = a;
  const pad = (v: number | string, n: number) => String(v).padStart(n);
  out.push(`\n[drilldown] ${slug}`);
  out.push(
    `span "${spanName}"  dur=${span.durationMs}ms  cpu.block=${span.cpu.blockingMs}ms  render.script=${span.render.scriptMs}ms`,
  );
  out.push(
    `  RunTask total ${round(a.tasks.totalMs)}ms / ${a.tasks.count} tasks` +
      `  (long tasks >=50ms: ${a.tasks.longTasksMs.map((d) => round(d) + "ms").join(", ") || "none"})`,
  );
  out.push(`\n  event-name total time (which subsystem):`);
  for (const r of a.byEventName) out.push(`    ${pad(r.totalMs, 8)}ms x${r.count}  ${r.name}`);
  out.push(`\n  function total time top ${topN} (includes children):`);
  if (a.byFunction.length === 0) {
    out.push("    no matching events (v8.execute category may be missing from the trace)");
  }
  for (const r of a.byFunction) out.push(`    ${pad(r.totalMs, 8)}ms x${r.count}  ${r.key}`);

  const k = a.self.byKind;
  out.push(
    `\n  function SELF time top ${topN} (own cost, from CPU profiler):` +
      `  [app ${round(k.app)}ms / harness ${round(k.harness)}ms / native ${round(k.native)}ms]`,
  );
  if (a.self.firstPartyDomain) {
    out.push(
      `    app self split: first-party ${round(a.self.byParty.first)}ms` +
        ` / third-party ${round(a.self.byParty.third)}ms  (page domain: ${a.self.firstPartyDomain})`,
    );
  }
  if (a.self.ranked.length === 0) {
    out.push("    no CPU profiler samples in window (was PERF_TRACE=1 with v8.cpu_profiler?)");
  }
  for (const r of a.self.ranked) {
    const tag = r.party === "third" ? "  [3p]" : r.kind === "app" ? "" : `  [${r.kind}]`;
    out.push(`    ${pad(r.selfMs, 8)}ms  ${r.key}${tag}`);
  }

  if (a.thirdPartyByDomain.length > 0) {
    out.push(`\n  third-party CPU by domain (self time the app didn't author):`);
    for (const r of a.thirdPartyByDomain) out.push(`    ${pad(r.selfMs, 8)}ms  ${r.domain}`);
  }

  out.push(
    `\n  GPU rendering load (GPU process):  GPUTask total ${round(a.gpu.gpuTaskMs)}ms` +
      `  (render.gpu=${span.render?.gpuMs ?? "n/a"}ms)`,
  );
  if (a.gpu.ranked.length === 0) {
    out.push("    no GPU events in window (software GL / SwiftShader emits none — use PERF_GPU=1)");
  }
  for (const r of a.gpu.ranked) out.push(`    ${pad(r.totalMs, 8)}ms x${r.count}  ${r.name}`);

  if (a.initiators.length > 0) {
    out.push(
      `\n  network initiators (who issued the ${span.network?.requestCount} requests, ${span.network?.waves} waves):`,
    );
    for (const it of a.initiators) {
      out.push(`    ${pad(it.requestCount, 4)} reqs  ${pad(it.encodedKB, 7)}KB  ${it.frame}  [${it.type}]`);
    }
  }

  if (a.imageDecode.count > 0) {
    out.push(
      `\n  image decode: ${round(a.imageDecode.ms)}ms across ${a.imageDecode.count} decodes (oversized images cost more to decode)`,
    );
  }

  if (a.selectors) {
    const sel = a.selectors;
    out.push(
      `\n  CSS selector match cost (${sel.count} selectors, ${round(sel.totalUs / 1000)}ms total matching):`,
    );
    out.push(
      `    note: PERF_CSS instruments every match attempt, so the recalc TIME is inflated` +
        ` (this run's recalc=${span.render?.recalcStyleMs ?? "n/a"}ms). Use this to find WHICH` +
        ` selectors; read recalcStyleMs from a normal run for the real magnitude.`,
    );
    out.push(`    slowest selectors (match time):`);
    for (const s of sel.slowest) {
      out.push(
        `      ${pad(round(s.us / 1000), 7)}ms  attempts=${s.attempts}  matches=${s.matches}  ${s.selector}`,
      );
    }
    if (sel.wasteful.length > 0) {
      out.push(`    wasteful selectors (attempts, never matched — candidates to delete/scope):`);
      for (const s of sel.wasteful) {
        out.push(`      ${pad(s.attempts, 7)} attempts  ${round(s.us / 1000)}ms  ${s.selector}`);
      }
    }
  } else if ((span.render?.recalcStyleMs ?? 0) > 0) {
    out.push(
      `\n  CSS selector match cost: no SelectorStats in window (run with PERF_CSS=1 to see per-selector cost)`,
    );
  }
  return out;
}
