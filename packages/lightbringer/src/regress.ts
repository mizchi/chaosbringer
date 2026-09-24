// Baseline-relative regression gate over median aggregates. Pure; the driver
// is scripts/regress.mjs. This is the complement to per-span budgets: budgets
// are absolute bounds maintained by hand, this catches "the PR made open-cart
// 35% slower" without anyone declaring a number.
//
// Every tracked metric is "lower is better", so a regression is an increase.
// A regression needs BOTH a relative increase past the threshold AND an
// absolute increase of at least the metric's floor, so a 1ms → 2ms swing is
// not reported as "+100%". A would-be regression whose median is noisy on
// either side is downgraded to a warning: the comparison cannot be trusted.
import { round } from "./analyze/util";
import type { MedianReport, MedianSpan, Stat } from "./stats";

/** Default relative threshold: a metric must get 15% worse to count. */
export const DEFAULT_REGRESS_THRESHOLD = 0.15;

export interface RegressSpanMetric {
  key: string;
  /** printed name, e.g. "cpu.blockingMs" */
  label: string;
  get: (s: MedianSpan) => Stat | undefined;
  /** minimum absolute change that counts, in the metric's own unit */
  floor: number;
}

/** The span metrics compared, in print order, with their absolute floors. */
export const REGRESS_SPAN_METRICS: readonly RegressSpanMetric[] = [
  { key: "durationMs", label: "durationMs", get: (s) => s.durationMs, floor: 5 },
  { key: "scriptMs", label: "render.scriptMs", get: (s) => s.render?.scriptMs, floor: 2 },
  { key: "blockingMs", label: "cpu.blockingMs", get: (s) => s.cpu?.blockingMs, floor: 5 },
  { key: "busyMs", label: "network.busyMs", get: (s) => s.network?.busyMs, floor: 10 },
  { key: "encodedKB", label: "network.encodedKB", get: (s) => s.network?.encodedKB, floor: 10 },
  { key: "requestCount", label: "network.requestCount", get: (s) => s.network?.requestCount, floor: 1 },
  { key: "waves", label: "network.waves", get: (s) => s.network?.waves, floor: 1 },
  { key: "thirdPartyKB", label: "network.thirdPartyKB", get: (s) => s.network?.thirdPartyKB, floor: 10 },
  { key: "layoutCount", label: "render.layoutCount", get: (s) => s.render?.layoutCount, floor: 5 },
  { key: "recalcStyleMs", label: "render.recalcStyleMs", get: (s) => s.render?.recalcStyleMs, floor: 2 },
  { key: "nodes", label: "render.nodes", get: (s) => s.render?.nodes, floor: 50 },
  { key: "gpuMs", label: "render.gpuMs", get: (s) => s.render?.gpuMs, floor: 2 },
  { key: "paintCount", label: "render.paintCount", get: (s) => s.render?.paintCount, floor: 10 },
  { key: "jsHeapUsedMB", label: "memory.jsHeapUsedMB", get: (s) => s.memory?.jsHeapUsedMB, floor: 1 },
  { key: "jsEventListeners", label: "memory.jsEventListeners", get: (s) => s.memory?.jsEventListeners, floor: 10 },
  { key: "interactionMs", label: "interaction.maxDurationMs", get: (s) => s.interaction?.maxDurationMs, floor: 16 },
  // Callers whose runs are noisier (chaosbringer's crawls) raise these two
  // through RegressOptions.floors rather than here, so lightbringer-regress
  // keeps gating as it always has.
  { key: "droppedFrames", label: "frames.droppedFrames", get: (s) => s.frames?.droppedFrames, floor: 2 },
  { key: "longestFrameMs", label: "frames.longestFrameMs", get: (s) => s.frames?.longestFrameMs, floor: 16 },
];

/** The web-vitals compared, in print order, with their absolute floors. */
export const REGRESS_VITAL_METRICS: readonly { key: string; floor: number }[] = [
  { key: "LCP", floor: 50 },
  { key: "INP", floor: 20 },
  { key: "CLS", floor: 0.01 },
  { key: "TTFB", floor: 20 },
  { key: "FCP", floor: 50 },
];

/** (cur − base) / base; Infinity for growth from 0 (a metric that appeared). */
export function relativeChange(base: number, cur: number): number {
  return base === 0 ? (cur > 0 ? Infinity : 0) : (cur - base) / base;
}

/** "+12%" / "-8%"; "new" for growth from 0. */
export function formatPct(p: number): string {
  if (p === Infinity) return "new";
  const s = Math.round(p * 100);
  return `${s >= 0 ? "+" : ""}${s}%`;
}

export type ChangeKind = "regression" | "noisy" | "improvement" | "ok";

export interface Change {
  /**
   * regression: worse past the threshold and the floor (hard fail);
   * noisy: would regress, but either side's median is noisy (warn only);
   * improvement: better past the threshold and the floor (info);
   * ok: neither.
   */
  kind: ChangeKind;
  base: number;
  cur: number;
  /** relative change, see relativeChange */
  p: number;
  delta: number;
}

/** Classify one metric; null when either side did not measure it. */
export function classifyChange(
  baseStat: Stat | undefined,
  curStat: Stat | undefined,
  floor: number,
  threshold: number = DEFAULT_REGRESS_THRESHOLD,
): Change | null {
  if (!baseStat || !curStat) return null;
  const base = baseStat.median;
  const cur = curStat.median;
  const delta = cur - base;
  const p = relativeChange(base, cur);
  const noisy = baseStat.noisy || curStat.noisy;
  const worse = p > threshold && delta >= floor;
  const better = p < -threshold && -delta >= floor;
  if (worse) return { kind: noisy ? "noisy" : "regression", base, cur, p, delta };
  if (better) return { kind: "improvement", base, cur, p, delta };
  return { kind: "ok", base, cur, p, delta };
}

export interface RegressOptions {
  /** relative threshold (default 0.15) */
  threshold?: number;
  /** per-metric absolute floor overrides, by metric key (span keys and vital names) */
  floors?: Record<string, number>;
}

/** The aggregate fields regress() reads (a MedianReport satisfies it). */
export type RegressInput = Pick<MedianReport, "spans"> & { vitals?: MedianReport["vitals"] };

/** Median aggregates by slug; iteration order is the report order. */
export type MedianSet = Map<string, RegressInput> | Record<string, RegressInput>;

/** One non-ok comparison, or a span with no baseline, in print order. */
export type RegressLine =
  | { type: "new-span"; span: string }
  | {
      type: "change";
      /** span name; absent for a vital */
      span?: string;
      metric: string;
      label: string;
      change: Change;
    };

export interface SlugRegress {
  slug: string;
  /** false: the baseline has no aggregate for this slug; it was skipped */
  hasBaseline: boolean;
  lines: RegressLine[];
}

export interface RegressFinding {
  slug: string;
  /** "<span>.<label>" or "vitals.<key>" */
  subject: string;
  vital: boolean;
  change: Change;
}

export interface RegressResult {
  threshold: number;
  slugs: SlugRegress[];
  regressions: RegressFinding[];
  /** would-be regressions on a noisy median */
  warnings: RegressFinding[];
  improvements: number;
}

function entriesOf(set: MedianSet): [string, RegressInput][] {
  return set instanceof Map ? [...set.entries()] : Object.entries(set);
}

/**
 * Compare every current aggregate with its baseline (matched by slug, spans
 * matched by name). Slugs and spans with no baseline are reported, not failed.
 */
export function regress(
  baseline: MedianSet,
  current: MedianSet,
  opts: RegressOptions = {},
): RegressResult {
  const threshold = opts.threshold ?? DEFAULT_REGRESS_THRESHOLD;
  const floorOf = (key: string, def: number) => opts.floors?.[key] ?? def;
  const baseBySlug = new Map(entriesOf(baseline));
  const result: RegressResult = {
    threshold,
    slugs: [],
    regressions: [],
    warnings: [],
    improvements: 0,
  };
  const record = (slug: string, subject: string, vital: boolean, change: Change) => {
    const f = { slug, subject, vital, change };
    if (change.kind === "regression") result.regressions.push(f);
    else if (change.kind === "noisy") result.warnings.push(f);
    else result.improvements++;
  };

  for (const [slug, cur] of entriesOf(current)) {
    const base = baseBySlug.get(slug);
    if (!base) {
      result.slugs.push({ slug, hasBaseline: false, lines: [] });
      continue;
    }
    const lines: RegressLine[] = [];
    for (const curSpan of cur.spans) {
      const baseSpan = base.spans.find((s) => s.name === curSpan.name);
      if (!baseSpan) {
        lines.push({ type: "new-span", span: curSpan.name });
        continue;
      }
      for (const m of REGRESS_SPAN_METRICS) {
        const c = classifyChange(m.get(baseSpan), m.get(curSpan), floorOf(m.key, m.floor), threshold);
        if (!c || c.kind === "ok") continue;
        lines.push({ type: "change", span: curSpan.name, metric: m.key, label: m.label, change: c });
        record(slug, `${curSpan.name}.${m.label}`, false, c);
      }
    }
    for (const m of REGRESS_VITAL_METRICS) {
      const c = classifyChange(
        base.vitals?.[m.key],
        cur.vitals?.[m.key],
        floorOf(m.key, m.floor),
        threshold,
      );
      if (!c || c.kind === "ok") continue;
      lines.push({ type: "change", metric: m.key, label: `vitals.${m.key}`, change: c });
      record(slug, `vitals.${m.key}`, true, c);
    }
    result.slugs.push({ slug, hasBaseline: true, lines });
  }
  return result;
}

const MARK: Record<ChangeKind, string> = { regression: "✗", noisy: "~", improvement: "✓", ok: "" };

/** "<slug> / <subject> <base> → <cur> (<pct>)" */
function findingText(f: RegressFinding): string {
  const c = f.change;
  return `${f.slug} / ${f.subject} ${round(c.base)} → ${round(c.cur)} (${formatPct(c.p)})`;
}

/**
 * The report scripts/regress.mjs prints, split by stream: each entry is one
 * console.log / console.error call. `failed` is true when there are hard
 * regressions (the script's non-zero exit).
 */
export function formatRegress(
  r: RegressResult,
  { baselineLabel, currentLabel }: { baselineLabel: string; currentLabel: string },
): { stdout: string[]; stderr: string[]; failed: boolean } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  stdout.push(
    `\n[regress] baseline ${baselineLabel}  vs  current ${currentLabel}  (gate: +${Math.round(r.threshold * 100)}%)`,
  );
  for (const s of r.slugs) {
    if (!s.hasBaseline) {
      stdout.push(`\n  ${s.slug}  (no baseline — skipped)`);
      continue;
    }
    const lines = s.lines.map((l) => {
      if (l.type === "new-span") return `    span "${l.span}" is new (no baseline)`;
      const c = l.change;
      const head = l.span !== undefined ? `${l.span} / ${l.label}` : l.label;
      return `    ${head}  ${round(c.base)} → ${round(c.cur)}  (${formatPct(c.p)})  ${MARK[c.kind]}`;
    });
    if (lines.length) stdout.push(`\n  ${s.slug}\n${lines.join("\n")}`);
  }
  stdout.push("");
  if (r.improvements > 0) stdout.push(`  ✓ ${r.improvements} improvement(s)`);
  if (r.warnings.length > 0) {
    stdout.push(`\n[regress] noisy (warn only, ${r.warnings.length}):`);
    // Span warnings have always said why they cannot gate; vitals just "noisy".
    for (const w of r.warnings)
      stdout.push(`  ~ ${findingText(w)} — ${w.vital ? "noisy" : "noisy, can't gate"}`);
  }
  if (r.regressions.length > 0) {
    stderr.push(`\n[regress] REGRESSIONS (${r.regressions.length}):`);
    for (const f of r.regressions) stderr.push(`  ✗ ${findingText(f)}`);
    return { stdout, stderr, failed: true };
  }
  stdout.push("\n[regress] no regressions past the gate.");
  return { stdout, stderr, failed: false };
}
