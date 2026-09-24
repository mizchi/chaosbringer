// Statistics and budget gates over repeated runs. Pure: no Playwright, no
// filesystem. scripts/median.mjs and `lightbringer run --emit-budgets/--gate`
// are thin drivers over these, and chaosbringer's `perf` subcommands call the
// same functions on crawl reports, so the CLIs cannot drift apart.
//
// A single run is noisy (JIT / cache / GC), so everything here reads medians:
// regression checks, before/after comparisons and budget gates.
import { round } from "./analyze/util";
import { BUDGET_METRIC } from "./report-types";
import type { Budget, BudgetMetric, PerfReport, SpanReport, VitalsBudget } from "./report-types";

// ── robust summary ────────────────────────────────────────────────────────

/** Nearest-rank percentile (p in 0..1) of an ascending-sorted array; 0 when empty. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.round((sorted.length - 1) * p);
  return sorted[i]!;
}

/** Median rounded to one decimal (mean of the middle two for an even count); 0 when empty. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return round(s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2);
}

/**
 * A median with its IQR band (p25..p75). The band, not min..max, is the
 * reported spread, so one bad run does not blow it up. `noisy` flags a median
 * too unstable to gate on: IQR over 25% of the median. Medians of 5 or less
 * are never noisy, because a relative spread means nothing at that size.
 */
export interface Stat {
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
  noisy: boolean;
  n: number;
}

/** Relative IQR above which a median is flagged noisy. */
export const NOISY_IQR_RATIO = 0.25;
/** Medians at or below this are never flagged noisy. */
export const NOISY_MIN_MEDIAN = 5;

export function isNoisy(med: number, p25: number, p75: number): boolean {
  return med > NOISY_MIN_MEDIAN && (p75 - p25) / med > NOISY_IQR_RATIO;
}

/** Summarise a sample. Every number is rounded to one decimal. */
export function stat(values: readonly number[]): Stat {
  const s = [...values].sort((a, b) => a - b);
  const med = median(values);
  const p25 = round(percentile(s, 0.25));
  const p75 = round(percentile(s, 0.75));
  return {
    median: med,
    p25,
    p75,
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
    noisy: isNoisy(med, p25, p75),
    n: values.length,
  };
}

/** "median (p25..p75)", with " !noisy" appended to an unstable median. */
export function formatStat(s: Stat): string {
  return `${s.median} (${s.p25}..${s.p75})${s.noisy ? " !noisy" : ""}`;
}

// ── per-slug aggregate (the <slug>.median.json shape) ──────────────────────

export interface MedianSpan {
  name: string;
  durationMs: Stat;
  network: {
    busyMs: Stat;
    waves: Stat;
    encodedKB: Stat;
    requestCount: Stat;
    thirdPartyKB: Stat;
    thirdPartyRequestCount: Stat;
  };
  cpu: { blockingMs: Stat; maxLongTaskMs: Stat };
  render: {
    recalcStyleCount: Stat;
    recalcStyleMs: Stat;
    layoutCount: Stat;
    layoutMs: Stat;
    nodes: Stat;
    scriptMs: Stat;
    /** paint / GPU: present only when a run measured them (PERF_TRACE) */
    paintCount?: Stat;
    paintMs?: Stat;
    gpuMs?: Stat;
  };
  memory?: {
    jsHeapUsedMB: Stat;
    jsHeapDeltaMB: Stat;
    arrayBuffers: Stat;
    domNodes: Stat;
    jsEventListeners: Stat;
    listenersDelta: Stat;
    documentsDelta: Stat;
  };
  interaction?: {
    maxDurationMs: Stat;
    inputDelayMs: Stat;
    processingMs: Stat;
    presentationMs: Stat;
  };
  frames?: { droppedFrames: Stat; longestFrameMs: Stat; fps: Stat };
  budget?: Budget;
}

export interface MedianAppSpan {
  name: string;
  /** app spans of this name across all runs (a measure may repeat within a run) */
  occurrences: number;
  durationMs: Stat;
  network: { busyMs: Stat };
  cpu: { blockingMs: Stat };
}

export interface MedianReport {
  slug: string;
  runs: number;
  vitals: Record<string, Stat>;
  vitalsBudget?: VitalsBudget;
  spans: MedianSpan[];
  appSpans: MedianAppSpan[];
}

/** The run-report fields aggregateRuns reads (a PerfReport satisfies it). */
export type RunReport = Pick<PerfReport, "vitals" | "spans"> &
  Partial<Pick<PerfReport, "appSpans" | "vitalsBudget">>;

function statBy<T>(items: readonly T[], selector: (item: T) => number): Stat {
  return stat(items.map(selector));
}

/** Names in first-seen order across runs. */
function namesInOrder(lists: Iterable<readonly { name: string }[]>): string[] {
  // Set keeps insertion order, so this is first-seen order across the lists.
  const seen = new Set<string>();
  for (const list of lists) for (const s of list) seen.add(s.name);
  return [...seen];
}

/**
 * Aggregate repeated runs of one scenario into per-span / per-app-span /
 * per-vital Stats. Spans are matched by name. A metric a run did not measure
 * counts as 0 in that run's sample, except where a whole group (paint, memory,
 * interaction, frames) is absent from every run, in which case it is left out.
 */
export function aggregateRuns(slug: string, runs: readonly RunReport[]): MedianReport {
  const vitalNames = new Set<string>();
  for (const r of runs) for (const k of Object.keys(r.vitals)) vitalNames.add(k);
  const vitals: Record<string, Stat> = {};
  for (const name of vitalNames) {
    const vals = runs
      .map((r) => (r.vitals as Record<string, { value?: number } | undefined>)[name]?.value)
      .filter((v): v is number => typeof v === "number");
    if (vals.length) vitals[name] = stat(vals);
  }

  const spans = namesInOrder(runs.map((r) => r.spans)).map((name): MedianSpan => {
    const items: SpanReport[] = runs.flatMap((r) => r.spans.filter((s) => s.name === name));
    const budget = items.find((s) => s.budget)?.budget;
    const hasPaint = items.some((s) => s.render?.paintCount !== undefined);
    const render: MedianSpan["render"] = {
      recalcStyleCount: statBy(items, (s) => s.render?.recalcStyleCount ?? 0),
      recalcStyleMs: statBy(items, (s) => s.render?.recalcStyleMs ?? 0),
      layoutCount: statBy(items, (s) => s.render?.layoutCount ?? 0),
      layoutMs: statBy(items, (s) => s.render?.layoutMs ?? 0),
      nodes: statBy(items, (s) => s.render?.nodes ?? 0),
      scriptMs: statBy(items, (s) => s.render?.scriptMs ?? 0),
    };
    if (hasPaint) {
      render.paintCount = statBy(items, (s) => s.render?.paintCount ?? 0);
      render.paintMs = statBy(items, (s) => s.render?.paintMs ?? 0);
      render.gpuMs = statBy(items, (s) => s.render?.gpuMs ?? 0);
    }
    const hasMemory = items.some((s) => s.memory !== undefined);
    const memory = hasMemory
      ? {
          jsHeapUsedMB: statBy(items, (s) => s.memory?.jsHeapUsedMB ?? 0),
          jsHeapDeltaMB: statBy(items, (s) => s.memory?.jsHeapDeltaMB ?? 0),
          arrayBuffers: statBy(items, (s) => s.memory?.arrayBuffers ?? 0),
          domNodes: statBy(items, (s) => s.memory?.domNodes ?? 0),
          jsEventListeners: statBy(items, (s) => s.memory?.jsEventListeners ?? 0),
          listenersDelta: statBy(items, (s) => s.memory?.listenersDelta ?? 0),
          documentsDelta: statBy(items, (s) => s.memory?.documentsDelta ?? 0),
        }
      : undefined;
    // Key order matches the historical <slug>.median.json output.
    return {
      name,
      durationMs: statBy(items, (s) => s.durationMs),
      network: {
        busyMs: statBy(items, (s) => s.network.busyMs),
        waves: statBy(items, (s) => s.network.waves ?? 0),
        encodedKB: statBy(items, (s) => s.network.encodedKB),
        requestCount: statBy(items, (s) => s.network.requestCount),
        thirdPartyKB: statBy(items, (s) => s.network.thirdParty?.encodedKB ?? 0),
        thirdPartyRequestCount: statBy(items, (s) => s.network.thirdParty?.requestCount ?? 0),
      },
      cpu: {
        blockingMs: statBy(items, (s) => s.cpu.blockingMs),
        maxLongTaskMs: statBy(items, (s) => s.cpu.maxLongTaskMs),
      },
      render,
      memory,
      interaction: items.some((s) => s.interaction)
        ? {
            maxDurationMs: statBy(items, (s) => s.interaction?.maxDurationMs ?? 0),
            inputDelayMs: statBy(items, (s) => s.interaction?.inputDelayMs ?? 0),
            processingMs: statBy(items, (s) => s.interaction?.processingMs ?? 0),
            presentationMs: statBy(items, (s) => s.interaction?.presentationMs ?? 0),
          }
        : undefined,
      frames: items.some((s) => s.frames)
        ? {
            droppedFrames: statBy(items, (s) => s.frames?.droppedFrames ?? 0),
            longestFrameMs: statBy(items, (s) => s.frames?.longestFrameMs ?? 0),
            fps: statBy(items, (s) => s.frames?.fps ?? 0),
          }
        : undefined,
      budget,
    };
  });

  const appSpans = namesInOrder(runs.map((r) => r.appSpans ?? [])).map((name) => {
    const items = runs.flatMap((r) => (r.appSpans ?? []).filter((s) => s.name === name));
    return {
      name,
      occurrences: items.length,
      durationMs: statBy(items, (s) => s.durationMs),
      network: { busyMs: statBy(items, (s) => s.network.busyMs) },
      cpu: { blockingMs: statBy(items, (s) => s.cpu.blockingMs) },
    };
  });

  const vitalsBudget = runs.find((r) => r.vitalsBudget)?.vitalsBudget;
  return { slug, runs: runs.length, vitals, vitalsBudget, spans, appSpans };
}

/** The human summary scripts/median.mjs prints for one aggregate (one string, newline-joined). */
export function formatMedianSummary(agg: MedianReport): string {
  const fmt = formatStat;
  const lines = [`\n[median] ${agg.slug}  (${agg.runs} runs)`];
  const v = agg.vitals;
  const vfmt = (name: string) => (v[name] ? fmt(v[name]!) : "n/a");
  lines.push(
    `  vitals  LCP=${vfmt("LCP")}  INP=${vfmt("INP")}  CLS=${vfmt("CLS")}  TTFB=${vfmt("TTFB")}`,
  );
  for (const s of agg.spans) {
    lines.push(`  ${s.name}  ${fmt(s.durationMs)}ms`);
    // A span whose network was busy for ~all of it is bounded by the network,
    // so its duration says little about the app's own cost.
    const saturated =
      s.durationMs.median > 50 && s.network.busyMs.median / s.durationMs.median > 0.9;
    lines.push(
      `      net    busy=${fmt(s.network.busyMs)}ms  reqs=${fmt(s.network.requestCount)}  waves=${fmt(s.network.waves)}  ${fmt(s.network.encodedKB)}KB` +
        (saturated ? "  (net-saturated: busyMs ≈ window)" : ""),
    );
    if (s.network.thirdPartyRequestCount && s.network.thirdPartyRequestCount.median > 0) {
      lines.push(
        `      3p     reqs=${fmt(s.network.thirdPartyRequestCount)}  ${fmt(s.network.thirdPartyKB)}KB`,
      );
    }
    lines.push(`      cpu    block=${fmt(s.cpu.blockingMs)}ms  maxTask=${fmt(s.cpu.maxLongTaskMs)}ms`);
    if (s.interaction) {
      lines.push(
        `      inp    ${fmt(s.interaction.maxDurationMs)}ms  (input ${fmt(s.interaction.inputDelayMs)} / proc ${fmt(s.interaction.processingMs)} / present ${fmt(s.interaction.presentationMs)})`,
      );
    }
    if (s.frames && (s.frames.droppedFrames.median > 0 || s.frames.longestFrameMs.median > 33)) {
      lines.push(
        `      frames ${fmt(s.frames.fps)}fps  dropped=${fmt(s.frames.droppedFrames)}  longest=${fmt(s.frames.longestFrameMs)}ms`,
      );
    }
    const r = s.render;
    const paint = r.paintCount
      ? `  paint=${fmt(r.paintCount)}/${fmt(r.paintMs!)}ms  gpu=${fmt(r.gpuMs!)}ms`
      : "";
    lines.push(
      `      render style=${fmt(r.recalcStyleCount)}/${fmt(r.recalcStyleMs)}ms  layout=${fmt(r.layoutCount)}/${fmt(r.layoutMs)}ms  nodes=${fmt(r.nodes)}  script=${fmt(r.scriptMs)}ms${paint}`,
    );
    if (s.memory) {
      const m = s.memory;
      lines.push(
        `      mem    heap=${fmt(m.jsHeapUsedMB)}MB  Δheap=${fmt(m.jsHeapDeltaMB)}MB  arraybufs=${fmt(m.arrayBuffers)}  listeners=${fmt(m.jsEventListeners)} (Δ${fmt(m.listenersDelta)})`,
      );
    }
  }
  if (agg.appSpans.length) {
    lines.push("  app spans (performance.measure):");
    for (const s of agg.appSpans) {
      lines.push(
        `    ${s.name} x${s.occurrences}  ${fmt(s.durationMs)}ms  net=${fmt(s.network.busyMs)}ms  cpu=${fmt(s.cpu.blockingMs)}ms`,
      );
    }
  }
  return lines.join("\n");
}

// ── gate ────────────────────────────────────────────────────────────────────

/** A value to gate: a Stat (median + IQR, can warn when noisy) or a bare median. */
export type Gateable = Stat | number;

/** One budget check that did not pass cleanly. */
export interface GateFinding {
  /** what the budget is scoped to: a span name, or "vitals" */
  scope: string;
  metric: string;
  median: number;
  limit: number;
  /** set on warnings: the p75 that crosses the budget */
  p75?: number;
}

export interface GateResult {
  /** median > budget: fail */
  violations: GateFinding[];
  /**
   * median <= budget but the metric is noisy and its p75 exceeds the budget:
   * the gate could flip from run to run, so add runs before trusting it.
   * Only Stat values can warn; bare medians have no band.
   */
  warnings: GateFinding[];
}

/**
 * Gate values against budgets, both keyed scope → metric. Budgets are walked
 * in their own order; a metric with no value (not measured, e.g. paint without
 * PERF_TRACE) or a null limit is skipped rather than failed.
 */
export function gate(
  values: Record<string, Record<string, Gateable | undefined> | undefined>,
  budgets: Record<string, Record<string, number | null | undefined> | undefined>,
): GateResult {
  const violations: GateFinding[] = [];
  const warnings: GateFinding[] = [];
  for (const [scope, metrics] of Object.entries(budgets)) {
    for (const [metric, limit] of Object.entries(metrics ?? {})) {
      const value = values[scope]?.[metric];
      if (limit == null || value == null) continue;
      const med = typeof value === "number" ? value : value.median;
      if (med > limit) {
        violations.push({ scope, metric, median: med, limit });
      } else if (typeof value !== "number" && value.noisy && value.p75 > limit) {
        warnings.push({ scope, metric, median: med, limit, p75: value.p75 });
      }
    }
  }
  return { violations, warnings };
}

/** "<slug> / <scope>.<metric> median=<m> > budget <limit>" */
export function formatGateViolation(slug: string, f: GateFinding): string {
  return `${slug} / ${f.scope}.${f.metric} median=${f.median} > budget ${f.limit}`;
}

/**
 * "<slug> / <scope>.<metric> median=<m> <= <limit> but noisy (p75=<p75>)", plus
 * the "add runs" hint. median.mjs has always omitted the hint on vitals
 * warnings; `hint: false` keeps that output unchanged.
 */
export function formatGateWarning(
  slug: string,
  f: GateFinding,
  { hint = true }: { hint?: boolean } = {},
): string {
  return (
    `${slug} / ${f.scope}.${f.metric} median=${f.median} <= ${f.limit} but noisy (p75=${f.p75})` +
    (hint ? " — gate may be flaky, add runs" : "")
  );
}

/** Budget field → the aggregated Stat it gates (undefined when not measured). */
export const MEDIAN_BUDGET_STAT: Record<BudgetMetric, (s: MedianSpan) => Stat | undefined> = {
  durationMs: (s) => s.durationMs,
  scriptMs: (s) => s.render.scriptMs,
  blockingMs: (s) => s.cpu.blockingMs,
  encodedKB: (s) => s.network.encodedKB,
  requestCount: (s) => s.network.requestCount,
  waves: (s) => s.network.waves,
  busyMs: (s) => s.network.busyMs,
  thirdPartyKB: (s) => s.network.thirdPartyKB,
  thirdPartyRequestCount: (s) => s.network.thirdPartyRequestCount,
  layoutCount: (s) => s.render.layoutCount,
  recalcStyleMs: (s) => s.render.recalcStyleMs,
  recalcStyleCount: (s) => s.render.recalcStyleCount,
  nodes: (s) => s.render.nodes,
  paintMs: (s) => s.render.paintMs, // only present with PERF_TRACE
  paintCount: (s) => s.render.paintCount,
  gpuMs: (s) => s.render.gpuMs, // only present with PERF_TRACE
  jsHeapUsedMB: (s) => s.memory?.jsHeapUsedMB,
  jsHeapDeltaMB: (s) => s.memory?.jsHeapDeltaMB,
  listenersDelta: (s) => s.memory?.listenersDelta,
  interactionMs: (s) => s.interaction?.maxDurationMs,
  droppedFrames: (s) => s.frames?.droppedFrames,
  longestFrameMs: (s) => s.frames?.longestFrameMs,
};

/**
 * The median gate scripts/median.mjs applies: each span's declared budget and
 * the vitals budget, checked against the aggregate's medians, as the lines it
 * prints (violations fail; warnings are noisy metrics whose IQR straddles the
 * budget).
 */
export function checkMedianBudgets(agg: MedianReport): { violations: string[]; warnings: string[] } {
  const violations: string[] = [];
  const warnings: string[] = [];
  // One gate() per span keeps the span order even for names that are integer
  // keys (which an object would iterate first).
  for (const s of agg.spans) {
    if (!s.budget) continue;
    const values: Record<string, Stat | undefined> = {};
    for (const k of Object.keys(s.budget)) {
      const get = MEDIAN_BUDGET_STAT[k as BudgetMetric];
      if (get) values[k] = get(s);
    }
    const r = gate({ [s.name]: values }, { [s.name]: s.budget as Record<string, number> });
    violations.push(...r.violations.map((f) => formatGateViolation(agg.slug, f)));
    warnings.push(...r.warnings.map((f) => formatGateWarning(agg.slug, f)));
  }
  if (agg.vitalsBudget) {
    const r = gate({ vitals: agg.vitals }, { vitals: agg.vitalsBudget as Record<string, number> });
    violations.push(...r.violations.map((f) => formatGateViolation(agg.slug, f)));
    warnings.push(...r.warnings.map((f) => formatGateWarning(agg.slug, f, { hint: false })));
  }
  return { violations, warnings };
}

// ── emitted budgets (lightbringer run --emit-budgets / --gate) ─────────────

/**
 * The metrics `lightbringer run --emit-budgets` writes budgets for: the ones
 * stable enough across runs that ×1.25 of the median is a meaningful bound.
 */
const EMIT_KEYS = [
  "durationMs",
  "scriptMs",
  "blockingMs",
  "layoutCount",
  "recalcStyleMs",
  "encodedKB",
  "requestCount",
  "interactionMs",
] as const satisfies readonly BudgetMetric[];
// Readers come from BUDGET_METRIC so a span's emitted budget and the value
// checkBudgets later compares against it are read the same way.
export const EMIT_BUDGET_METRICS: Record<string, (s: SpanReport) => number | undefined> = Object.fromEntries(
  EMIT_KEYS.map((k) => [k, BUDGET_METRIC[k]]),
);

/** span name → metric → median */
export type SpanMedians = Record<string, Record<string, number>>;

/**
 * Median of each metric per span name across runs. A metric absent from a run
 * (e.g. interactionMs on a span without input) is left out of its sample, and
 * out of the result when no run measured it.
 */
export function spanMedians(
  runs: readonly Pick<PerfReport, "spans">[],
  metrics: Record<string, (s: SpanReport) => number | undefined> = EMIT_BUDGET_METRICS,
): SpanMedians {
  const out: SpanMedians = {};
  for (const name of namesInOrder(runs.map((r) => r.spans))) {
    const spans = runs.flatMap((r) => r.spans.filter((s) => s.name === name));
    out[name] = {};
    for (const [k, get] of Object.entries(metrics)) {
      const vals = spans.map(get).filter((v): v is number => typeof v === "number");
      if (vals.length) out[name]![k] = median(vals);
    }
  }
  return out;
}

/** Default headroom of emitted budgets over the measured median. */
export const DEFAULT_BUDGET_HEADROOM = 1.25;

/**
 * Budgets from medians: ceil(median × headroom) per span and metric, so a
 * budget is never tighter than what was measured and is always an integer.
 * `metrics` restricts which metrics get a budget (default: all present).
 */
export function emitBudgets(
  medians: SpanMedians,
  { headroom = DEFAULT_BUDGET_HEADROOM, metrics }: { headroom?: number; metrics?: readonly string[] } = {},
): SpanMedians {
  const out: SpanMedians = {};
  for (const [span, values] of Object.entries(medians)) {
    out[span] = {};
    for (const [k, v] of Object.entries(values)) {
      if (metrics && !metrics.includes(k)) continue;
      out[span]![k] = Math.ceil(v * headroom);
    }
  }
  return out;
}
