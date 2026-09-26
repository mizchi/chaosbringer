/**
 * `chaosbringer perf <sub>` — the crawl-report counterparts of lightbringer's
 * repeated-run tools:
 *
 *   emit-budgets  medians per perfKey over N crawl reports → a budgets file
 *   gate          medians vs a budgets file; noisy metrics warn, breaches fail
 *   regress       per-perfKey medians, current vs baseline (threshold + floors)
 *   drilldown     trace breakdown of one span (needs --perf-trace)
 *
 * The statistics are lightbringer's own (`aggregateRuns`, `spanMedians`,
 * `emitBudgets`, `gate`, `regress`, `analyseDrilldown`), called on the spans
 * of crawl reports instead of lightbringer run reports, so `lightbringer run
 * --emit-budgets/--gate` and these commands cannot drift apart. The only
 * translation is naming: lightbringer groups spans by `name`, a crawl groups
 * them by `perfKey`, so each span is handed over with `name = key`.
 *
 * The pure steps are exported for tests; `runPerfCli` only reads files,
 * prints and sets `process.exitCode`.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  aggregateRuns,
  analyseDrilldown,
  BUDGET_METRIC,
  median,
  DEFAULT_BUDGET_HEADROOM,
  DEFAULT_REGRESS_THRESHOLD,
  DRILLDOWN_TOP_N,
  EMIT_BUDGET_METRICS,
  emitBudgets,
  formatDrilldown,
  formatRegress,
  gate,
  MEDIAN_BUDGET_STAT,
  regress,
  spanMedians,
  type Budget,
  type BudgetMetric,
  type DrilldownTraceEvent,
  type GateFinding,
  type MedianReport,
  type RegressResult,
  type SpanReport,
  type Stat,
} from "lightbringer/core";
import { perfBudgetRulesFromJson, type PerfBudgetsFile } from "./budget.js";
import { PERF_KEY_VERSION, perfKeyVersionOf, perfRuleMatcher } from "./perf-key.js";
import { DEFAULT_PERF_TRACE_DIR } from "./perf-options.js";
import { reportSpans } from "./perf-summary.js";
import type { CrawlReport, PerfBudgetRule, PerfSettleRecord, PerfSpanReport } from "./types.js";
import { validatePerfBudgets } from "./validate.js";

/** Default output path of `perf emit-budgets`. */
export const DEFAULT_PERF_BUDGETS_PATH = "chaosbringer.perf-budgets.json";

/**
 * The slug every aggregate is filed under. lightbringer's gate/regress key
 * by scenario slug and then span name; a crawl is one scenario and its
 * spans are told apart by perfKey, so one fixed slug is enough.
 */
const CRAWL_SLUG = "crawl";

// ── reading reports ─────────────────────────────────────────────────────────

/** Read one crawl report, with an error that names the file. */
export function loadCrawlReport(path: string): CrawlReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`failed to read ${path}: ${err instanceof Error ? err.message : err}`);
  }
  if (!isCrawlReport(parsed)) {
    throw new Error(`${path} is not a chaosbringer crawl report (no pages / actions arrays)`);
  }
  return parsed;
}

function isCrawlReport(v: unknown): v is CrawlReport {
  const r = v as Partial<CrawlReport> | null;
  return !!r && typeof r === "object" && Array.isArray(r.pages) && Array.isArray(r.actions);
}

/**
 * Expand CLI operands into report paths: a file is itself, a directory is
 * every `*.json` in it that is a crawl report. Other JSON in a directory (a
 * budgets file kept next to the baselines) is skipped and counted, never
 * silently: `skipped` goes into the output.
 */
export function expandReportPaths(operands: readonly string[]): { paths: string[]; skipped: string[] } {
  const paths: string[] = [];
  const skipped: string[] = [];
  for (const op of operands) {
    if (existsSync(op) && statSync(op).isDirectory()) {
      for (const name of readdirSync(op).filter((n) => n.endsWith(".json")).sort()) {
        const p = join(op, name);
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(p, "utf-8"));
        } catch {
          skipped.push(p);
          continue;
        }
        if (isCrawlReport(parsed)) paths.push(p);
        else skipped.push(p);
      }
    } else {
      paths.push(op);
    }
  }
  return { paths, skipped };
}


/**
 * Read a `perfBudgets` JSON file. `source` names it in parse errors. The fs
 * read lives here rather than in budget.ts, which stays pure; each caller
 * still validates the rules its own way.
 */
export function readPerfBudgetRulesFile(path: string, source: string = path): PerfBudgetRule[] {
  return perfBudgetRulesFromJson(JSON.parse(readFileSync(path, "utf-8")), source);
}

/**
 * The crawler's `--perf-budgets` read: the rules, plus why the file cannot
 * be enforced on a crawl settling `crawl` (`crawlBudgetsSettleMismatch`) and
 * the exit code a refusal uses.
 */
export function readPerfBudgetsForCrawl(
  path: string,
  crawl: PerfSettleRecord,
  source: string = path,
): { rules: PerfBudgetRule[]; settleMismatch?: string; exitCode: number } {
  const json: unknown = JSON.parse(readFileSync(path, "utf-8"));
  const rules = perfBudgetRulesFromJson(json, source);
  const settleMismatch = crawlBudgetsSettleMismatch(json, crawl);
  return { rules, ...(settleMismatch ? { settleMismatch } : {}), exitCode: SETTLE_MISMATCH_EXIT_CODE };
}

/** A report's spans renamed to their key: the shape lightbringer's stats group by. */
function keyedRun(report: Pick<CrawlReport, "pages" | "actions">): {
  vitals: Record<string, never>;
  spans: SpanReport[];
} {
  return { vitals: {}, spans: reportSpans(report).map((s) => ({ ...s, name: s.key })) };
}

/** lightbringer's per-name aggregate over the reports, with perfKey as the name. */
export function aggregateByKey(reports: readonly Pick<CrawlReport, "pages" | "actions">[]): MedianReport {
  return aggregateRuns(CRAWL_SLUG, reports.map(keyedRun));
}

// ── emit-budgets ────────────────────────────────────────────────────────────

export interface EmitResult {
  file: PerfBudgetsFile;
  /** keys seen in fewer than half the reports, left out of `file` */
  skipped: { key: string; seenIn: number }[];
  reports: number;
}

/**
 * Budgets per perfKey: `ceil(median × headroom)` of the metrics lightbringer's
 * `--emit-budgets` writes (EMIT_BUDGET_METRICS). A key that appears in fewer
 * than half the reports is skipped — a budget from one run of five is a
 * single sample, and a key that comes and goes (a random action target) is
 * not one CI can hold to — and reported in `skipped`.
 */
export function emitPerfBudgets(
  reports: readonly (Pick<CrawlReport, "pages" | "actions"> & { perf?: Pick<NonNullable<CrawlReport["perf"]>, "keyVersion"> })[],
  { headroom = DEFAULT_BUDGET_HEADROOM, settle }: { headroom?: number; settle?: PerfSettleRecord } = {},
): EmitResult {
  const runs = reports.map(keyedRun);
  const seenIn = new Map<string, number>();
  for (const run of runs) {
    for (const key of new Set(run.spans.map((s) => s.name))) seenIn.set(key, (seenIn.get(key) ?? 0) + 1);
  }
  const skipped: EmitResult["skipped"] = [];
  const medians = spanMedians(runs, EMIT_BUDGET_METRICS);
  for (const [key, n] of seenIn) {
    if (n * 2 < reports.length) {
      skipped.push({ key, seenIn: n });
      delete medians[key];
    }
  }
  const budgets = emitBudgets(medians, { headroom, metrics: Object.keys(EMIT_BUDGET_METRICS) });
  return {
    file: {
      version: 1,
      headroom,
      budgets: budgets as PerfBudgetsFile["budgets"],
      // Recorded so `perf gate` can refuse reports settled another way.
      ...(settle ? { settle: { ...settle } } : {}),
      // The version of the reports' keys (the caller refuses mixed versions),
      // so gate can refuse reports whose keys mean something else.
      keyVersion: reports.length === 0 ? PERF_KEY_VERSION : perfKeyVersionOf(reports[0]!.perf?.keyVersion),
    },
    skipped,
    reports: reports.length,
  };
}

// ── settle mode ─────────────────────────────────────────────────────────────

/**
 * Exit code of a comparison refused because its inputs were settled
 * differently. Not 1: nothing regressed or broke a budget, the numbers were
 * never compared, and CI should be able to tell the two apart.
 */
export const SETTLE_MISMATCH_EXIT_CODE = 2;

/** A recorded settle mode as the `--settle` value that produces it. */
export function settleLabel(s: PerfSettleRecord): string {
  return s.mode === "networkidle" ? "networkidle" : `adaptive (quiet ${s.quietMs} ms)`;
}

/** One input of a comparison and the settle mode it recorded, if any. */
export interface SettleSource {
  /** which side of the comparison: "baseline", "current", "reports", "budgets" */
  side: string;
  /** file path, for the "not recorded" warning */
  source: string;
  settle: PerfSettleRecord | undefined;
}

export interface SettleCheck {
  /** Why the inputs cannot be compared (they recorded different modes), or undefined. */
  mismatch?: string;
  /** Sources that recorded no mode (written before it was recorded): not checked. */
  unrecorded: string[];
  /** The one mode every recording source agreed on, if there was exactly one. */
  agreed?: PerfSettleRecord;
}

/**
 * Were the inputs of a regress / gate / emit-budgets settled the same way?
 * The settle mode changes what a span measures — under `networkidle` the
 * crawler's fixed 100 ms pause after an action falls outside the action span
 * and the load span includes the networkidle wait; under adaptive the settle
 * is inside the action span and the load stops once the page is quiet — so
 * medians from two modes differ by the settle, not by the app, and read as
 * regressions (or improvements) that are not there. Sources that recorded no
 * mode cannot be checked and are listed, never assumed to match.
 */
export function checkSettleModes(sources: readonly SettleSource[]): SettleCheck {
  const bySide = new Map<string, Map<string, number>>();
  const modes = new Map<string, PerfSettleRecord>();
  const unrecorded: string[] = [];
  for (const s of sources) {
    if (!s.settle) {
      unrecorded.push(s.source);
      continue;
    }
    const label = settleLabel(s.settle);
    modes.set(label, s.settle);
    const side = bySide.get(s.side) ?? new Map<string, number>();
    bySide.set(s.side, side);
    side.set(label, (side.get(label) ?? 0) + 1);
  }
  if (modes.size <= 1) {
    const agreed = [...modes.values()][0];
    return { unrecorded, ...(agreed ? { agreed } : {}) };
  }
  const sides = [...bySide]
    .map(([side, m]) => `${side}: ${[...m].map(([label, n]) => `${label} ×${n}`).join(", ")}`)
    .join("; ");
  return {
    unrecorded,
    mismatch:
      `the inputs were crawled under different settle modes (${sides}). The settle mode changes what a ` +
      `span measures (under networkidle the crawler's 100 ms pause after an action is outside the action ` +
      `span; under adaptive the settle is inside it), so the medians would differ by the settle, not by the app`,
  };
}

/**
 * Run the settle check for a CLI subcommand and print its outcome. Returns
 * the check to go on with, or undefined after refusing (exit 2). With
 * `allow` a mismatch is a loud warning instead. Warnings go to stderr so
 * `--json` output stays parseable.
 */
function settleGate(cmd: string, sources: readonly SettleSource[], allow: boolean): SettleCheck | undefined {
  const check = checkSettleModes(sources);
  if (check.unrecorded.length > 0) {
    const shown = check.unrecorded.slice(0, 5).join(", ");
    const more = check.unrecorded.length > 5 ? ` and ${check.unrecorded.length - 5} more` : "";
    console.error(
      `[perf ${cmd}] warning: ${check.unrecorded.length} input(s) do not record their settle mode ` +
        `(perf.settle; written by an older chaosbringer), so they cannot be checked against the others — ` +
        `comparing crawls settled differently reports false regressions: ${shown}${more}`,
    );
  }
  if (check.mismatch) {
    if (allow) {
      console.error(`[perf ${cmd}] WARNING (--allow-settle-mismatch): ${check.mismatch}.`);
      return check;
    }
    console.error(
      `perf: ${cmd}: refusing to compare: ${check.mismatch}. Crawl every side with the same --settle, ` +
        `or pass --allow-settle-mismatch to compare anyway.`,
    );
    process.exitCode = SETTLE_MISMATCH_EXIT_CODE;
    return undefined;
  }
  return check;
}

// ── perfKey version ─────────────────────────────────────────────────────────

/** One input of a comparison and the perfKey version it was written with. */
export interface KeyVersionSource {
  side: string;
  source: string;
  /** as recorded; absent means version 1 */
  keyVersion: number | undefined;
}

/**
 * Why the inputs cannot be joined by key, or undefined. A perfKey's meaning
 * changed between versions (see `PERF_KEY_VERSION`), so the same key string
 * in inputs of different versions can name different steps: joined, their
 * medians differ by which steps were grouped, not by the app. Unlike an
 * unrecorded settle mode, an absent version is known — every report written
 * before it was recorded is version 1 — so it is checked, not just warned
 * about.
 */
export function checkKeyVersions(sources: readonly KeyVersionSource[]): string | undefined {
  const bySide = new Map<string, Map<number, number>>();
  const versions = new Set<number>();
  for (const s of sources) {
    const v = perfKeyVersionOf(s.keyVersion);
    versions.add(v);
    const side = bySide.get(s.side) ?? new Map<number, number>();
    bySide.set(s.side, side);
    side.set(v, (side.get(v) ?? 0) + 1);
  }
  if (versions.size <= 1) return undefined;
  const sides = [...bySide]
    .map(([side, m]) => `${side}: ${[...m].map(([v, n]) => `v${v} ×${n}`).join(", ")}`)
    .join("; ");
  return (
    `the inputs use different perfKey versions (${sides}). Version 2 keys an action after a navigating ` +
    `click by the page it ran on, version 1 by the page the visit began at, so the same key can name ` +
    `different steps`
  );
}

/**
 * Run the key-version check for a subcommand. Returns false after refusing
 * (exit 2, the same code as a settle mismatch: nothing was compared). With
 * `allow` a mismatch is a warning instead.
 */
function keyVersionGate(cmd: string, sources: readonly KeyVersionSource[], allow: boolean): boolean {
  const mismatch = checkKeyVersions(sources);
  if (!mismatch) return true;
  if (allow) {
    console.error(`[perf ${cmd}] WARNING (--allow-key-mismatch): ${mismatch}.`);
    return true;
  }
  console.error(
    `perf: ${cmd}: refusing to compare: ${mismatch}. Re-record the older side with this chaosbringer ` +
      `(re-emit budgets, or let the next baseline run replace the baseline), or pass --allow-key-mismatch ` +
      `to compare anyway.`,
  );
  process.exitCode = SETTLE_MISMATCH_EXIT_CODE;
  return false;
}

/** The key-version sources of a set of report files. */
function reportKeySources(side: string, paths: readonly string[], reports: readonly CrawlReport[]): KeyVersionSource[] {
  return reports.map((r, i) => ({ side, source: paths[i]!, keyVersion: r.perf?.keyVersion }));
}

/**
 * The crawler's `--perf-budgets` check, settle-wise: why the budgets file
 * (its parsed JSON) cannot be enforced on a crawl settling `crawl`, or
 * undefined. The same reasoning as `perf gate` — budgets from networkidle
 * crawls exclude the settle from action spans, an adaptive crawl includes
 * it, so every durationMs budget fails on the settle, not on the app. A
 * hand-written rules array, or a file written before `settle` was recorded,
 * has no mode to compare and passes.
 */
export function crawlBudgetsSettleMismatch(budgetsJson: unknown, crawl: PerfSettleRecord): string | undefined {
  if (budgetsJson === null || typeof budgetsJson !== "object" || Array.isArray(budgetsJson)) return undefined;
  const recorded = (budgetsJson as Partial<PerfBudgetsFile>).settle;
  if (!recorded || settleLabel(recorded) === settleLabel(crawl)) return undefined;
  return (
    `the budgets were measured under ${settleLabel(recorded)}, but this crawl settles ${settleLabel(crawl)}. ` +
    `The settle mode changes what a span measures (under networkidle the crawler's 100 ms pause after an ` +
    `action is outside the action span; under adaptive the settle is inside it), so the budgets would fail ` +
    `(or pass) on the settle, not on the app`
  );
}

/** The settle sources of a set of report files. */
function reportSettleSources(side: string, paths: readonly string[], reports: readonly CrawlReport[]): SettleSource[] {
  return reports.map((r, i) => ({ side, source: paths[i]!, settle: r.perf?.settle }));
}

// ── gate ────────────────────────────────────────────────────────────────────

export interface PerfGateResult {
  reports: number;
  /** measured spans across the reports */
  spans: number;
  violations: GateFinding[];
  warnings: GateFinding[];
  /** budgeted keys (exact form) or rules (glob form) that matched no measured span */
  unmeasured: string[];
  /** keys that had at least one budget applied */
  gatedKeys: number;
}

/**
 * Per-key budgets from rules: every rule matching a measured key applies,
 * as in the crawler's `perfBudgets`; where two rules bound the same metric
 * of a key, the tighter limit is the one that holds.
 */
function budgetsForKeys(
  keys: readonly string[],
  rules: readonly PerfBudgetRule[],
): { budgets: Record<string, Record<string, number>>; unmatched: string[] } {
  const budgets: Record<string, Record<string, number>> = {};
  const unmatched: string[] = [];
  for (const rule of rules) {
    const hits = keys.filter(perfRuleMatcher(rule));
    if (hits.length === 0) unmatched.push(rule.match);
    for (const key of hits) {
      const b = budgets[key] ?? {};
      budgets[key] = b;
      for (const [metric, limit] of Object.entries(rule.budget)) {
        if (typeof limit !== "number") continue;
        b[metric] = b[metric] === undefined ? limit : Math.min(b[metric]!, limit);
      }
    }
  }
  return { budgets, unmatched };
}

/**
 * Gate the medians of `reports` against `rules` (either budgets-file keys or
 * `perfBudgets` globs). lightbringer's `gate`: a median over its limit fails;
 * a median within it whose metric is noisy and whose p75 crosses it warns,
 * because that gate could flip from run to run. A budgeted metric the spans
 * did not measure is skipped, as in lightbringer.
 */
export function gatePerf(
  reports: readonly Pick<CrawlReport, "pages" | "actions">[],
  rules: readonly PerfBudgetRule[],
): PerfGateResult {
  const agg = aggregateByKey(reports);
  const byKey = new Map(agg.spans.map((s) => [s.name, s]));
  const rawByKey = new Map<string, PerfSpanReport[]>();
  for (const r of reports) {
    for (const s of reportSpans(r)) {
      const list = rawByKey.get(s.key) ?? [];
      list.push(s);
      rawByKey.set(s.key, list);
    }
  }
  const { budgets, unmatched } = budgetsForKeys([...byKey.keys()], rules);
  const values: Record<string, Record<string, Stat | number | undefined>> = {};
  for (const [key, b] of Object.entries(budgets)) {
    const span = byKey.get(key)!;
    const raw = rawByKey.get(key) ?? [];
    values[key] = {};
    for (const metric of Object.keys(b)) {
      const get = MEDIAN_BUDGET_STAT[metric as keyof Budget];
      if (!get) continue;
      // An optional metric (interactionMs on a click that produced no event
      // timing entry, frames, memory) is counted as 0 by aggregateRuns for
      // every span that did not measure it. emit-budgets — like lightbringer's
      // `run --gate` — budgets from spanMedians, which leaves those spans out
      // of the sample. Gating the padded median against that budget would let
      // a key whose interaction is measured in 1 of 4 spans pass any slowdown,
      // so when some span of the key lacks the metric, the value gated is the
      // measured-only median (a plain number: no noise band, as in `run
      // --gate`). When every span measured it the two agree, and the Stat is
      // kept for its noisy-p75 warning.
      // BUDGET_METRIC has MEDIAN_BUDGET_STAT's keys, so `get` above vouches
      // for this reader too.
      const read = BUDGET_METRIC[metric as BudgetMetric];
      const measured = raw.map((s) => read(s)).filter((v): v is number => typeof v === "number");
      if (measured.length < raw.length) {
        if (measured.length > 0) values[key]![metric] = median(measured);
      } else {
        values[key]![metric] = get(span);
      }
    }
  }
  const { violations, warnings } = gate(values, budgets);
  return {
    reports: reports.length,
    spans: [...rawByKey.values()].reduce((n, l) => n + l.length, 0),
    violations,
    warnings,
    unmeasured: unmatched,
    gatedKeys: Object.keys(budgets).length,
  };
}

/**
 * Why a gate run checked nothing, or undefined when it checked something. A
 * gate that measured nothing must not read as "within budget": a mistyped
 * report directory, or a PR whose --perf crawl silently measured no spans,
 * would otherwise turn CI green.
 */
export function perfGateNothingChecked(r: PerfGateResult): string | undefined {
  if (r.reports === 0) return "no crawl reports to gate";
  if (r.spans === 0) return `no measured spans in ${r.reports} report(s) — were the crawls run with --perf?`;
  if (r.gatedKeys === 0) return "no budget matched any measured span — nothing was gated";
  return undefined;
}

export function formatPerfGate(r: PerfGateResult): { lines: string[]; failed: boolean } {
  const lines = [`[perf gate] ${r.reports} report(s), ${r.gatedKeys} budgeted key(s)`];
  const nothing = perfGateNothingChecked(r);
  for (const f of r.violations) {
    lines.push(`  ✗ ${f.scope}  ${f.metric} median=${f.median} > budget ${f.limit}`);
  }
  for (const f of r.warnings) {
    lines.push(
      `  ~ ${f.scope}  ${f.metric} median=${f.median} <= ${f.limit} but noisy (p75=${f.p75}) — gate may be flaky, add runs`,
    );
  }
  if (r.unmeasured.length > 0) {
    lines.push(`  ${r.unmeasured.length} budget(s) matched no measured span (not gated):`);
    for (const k of r.unmeasured) lines.push(`    ${k}`);
  }
  const failed = r.violations.length > 0 || nothing !== undefined;
  lines.push(
    nothing !== undefined
      ? `[perf gate] FAILED: ${nothing}`
      : r.violations.length > 0
        ? `[perf gate] FAILED: ${r.violations.length} violation(s)`
        : `[perf gate] passed${r.warnings.length > 0 ? ` with ${r.warnings.length} noisy warning(s)` : ""}`,
  );
  return { lines, failed };
}

// ── regress ─────────────────────────────────────────────────────────────────

/**
 * lightbringer's `regress` on per-perfKey medians: a metric regresses when
 * it grows past `threshold` AND by at least its absolute floor; a would-be
 * regression on a noisy median only warns. Keys with no baseline are listed
 * as new, not failed.
 */
export function regressPerf(
  baseline: readonly Pick<CrawlReport, "pages" | "actions">[],
  current: readonly Pick<CrawlReport, "pages" | "actions">[],
  { threshold = DEFAULT_REGRESS_THRESHOLD }: { threshold?: number } = {},
): RegressResult {
  return regress(
    { [CRAWL_SLUG]: aggregateByKey(baseline) },
    { [CRAWL_SLUG]: aggregateByKey(current) },
    { threshold, floors: CRAWL_REGRESS_FLOORS },
  );
}

/**
 * Floors raised over lightbringer's defaults for crawls, passed through
 * RegressOptions.floors so lightbringer-regress itself is unchanged.
 *
 * droppedFrames 4, not 2: headless Chromium on a shared CPU drops a few
 * frames during a plain page load with no app work at all (0 → 2 and 0 → 4
 * medians on clean same-seed playground crawls), so 2 flagged runner noise.
 * Four frames is ~67 ms of jank; smaller main-thread stalls are still caught
 * by scriptMs / blockingMs, whose floors are far tighter.
 *
 * longestFrameMs 17, not 16: frame durations come in whole vsync intervals
 * (16.7 ms at 60 Hz), so 16 let a one-frame jitter (16.8 → 33.3, seen on a
 * clean same-seed crawl) fail. 17 is "more than one frame".
 *
 * durationMs 17, not 5: an action span's wall time ends on its settle wait
 * (rAFs, the quiet window), so it moves in frame-sized steps too; a clean
 * PR run saw a 51.4 → 60.7 ms click median (+18%) from runner noise alone.
 * A real slowdown in the handler still shows in scriptMs / blockingMs.
 */
export const CRAWL_REGRESS_FLOORS: Readonly<Record<string, number>> = {
  durationMs: 17,
  droppedFrames: 4,
  longestFrameMs: 17,
};

/**
 * Why a regress run compared nothing, or undefined. The baseline side
 * having spans but the current side none is the silent-green case: a PR
 * whose --perf crawl measured nothing has no metric that can regress.
 */
export function regressNothingMeasured(
  baseline: readonly Pick<CrawlReport, "pages" | "actions">[],
  current: readonly Pick<CrawlReport, "pages" | "actions">[],
): string | undefined {
  const count = (rs: typeof baseline) => rs.reduce((n, r) => n + reportSpans(r).length, 0);
  if (count(baseline) === 0) return `no measured spans in the ${baseline.length} baseline report(s) — were they crawled with --perf?`;
  if (count(current) === 0) return `no measured spans in the ${current.length} current report(s) — were they crawled with --perf?`;
  return undefined;
}

/** Keys measured in the baseline that no current report measured, sorted. */
export function missingKeys(
  baseline: readonly Pick<CrawlReport, "pages" | "actions">[],
  current: readonly Pick<CrawlReport, "pages" | "actions">[],
): string[] {
  const cur = new Set(current.flatMap((r) => reportSpans(r).map((s) => s.key)));
  return [...new Set(baseline.flatMap((r) => reportSpans(r).map((s) => s.key)))]
    .filter((k) => !cur.has(k))
    .sort();
}

// ── drilldown ───────────────────────────────────────────────────────────────

/** The `--perf-out` directory a report's `reproCommand` names, if any. */
export function perfOutFromRepro(reproCommand: string | undefined): string | undefined {
  const m = reproCommand?.match(/--perf-out ('(?:[^']|'\\'')*'|\S+)/);
  if (!m) return undefined;
  const raw = m[1]!;
  return raw.startsWith("'") ? raw.slice(1, -1).replace(/'\\''/g, "'") : raw;
}

/**
 * Where a report's sidecar files are. `reportPath` is relative to the
 * crawl's `perf.outDir`, which the report records only through its repro
 * command, and relative to the directory the crawl ran in. Candidates, in
 * order: `--perf-dir`, the repro command's `--perf-out`, the trace default
 * `chaosbringer-perf`; each against the cwd, then against the report file's
 * directory. The first holding `reportPath` wins; `tried` lists them all.
 */
export function resolveSidecar(
  reportPath: string,
  { perfDir, reportFile, reproCommand }: { perfDir?: string; reportFile: string; reproCommand?: string },
): { path: string | null; tried: string[] } {
  const dirs = [perfDir, perfOutFromRepro(reproCommand), DEFAULT_PERF_TRACE_DIR].filter(
    (d): d is string => d !== undefined,
  );
  const tried: string[] = [];
  for (const d of dirs) {
    const bases = isAbsolute(d) ? [d] : [resolve(d), resolve(dirname(reportFile), d)];
    for (const base of bases) {
      const p = join(base, reportPath);
      if (tried.includes(p)) continue;
      tried.push(p);
      if (existsSync(p)) return { path: p, tried };
    }
  }
  return { path: null, tried };
}

interface SidecarReport {
  url?: string;
  tracePath?: string;
  spans: (SpanReport & { key?: string })[];
}

export interface DrilldownTarget {
  span: SpanReport & { key?: string };
  pageUrl?: string;
  sidecarPath: string;
  tracePath: string;
  /** how many spans across the report had this key (the slowest is drilled) */
  occurrences: number;
}

/**
 * Find the span to drill into: the slowest span with `key` across the
 * crawl's pages, read from each page's sidecar (which has the untrimmed
 * span and the trace path). Throws with the reason — and what to rerun with —
 * when the key is unknown, the crawl wrote no sidecars, or there is no trace.
 */
export function findDrilldownTarget(
  report: CrawlReport,
  key: string,
  { reportFile, perfDir }: { reportFile: string; perfDir?: string },
): DrilldownTarget {
  const keys = new Set(reportSpans(report).map((s) => s.key));
  if (!keys.has(key)) {
    const list = [...keys].sort();
    const shown = list.slice(0, 20).map((k) => `  ${k}`);
    if (list.length > 20) shown.push(`  … and ${list.length - 20} more`);
    throw new Error(
      list.length === 0
        ? `no measured spans in ${reportFile} — was the crawl run with --perf?`
        : `no span with key "${key}" in ${reportFile}. Keys:\n${shown.join("\n")}`,
    );
  }
  // Every page's sidecar, not just the pages of the key's route: an action's
  // route is the live URL when it began (B17), so a step after a navigating
  // click, or any step of a redirected visit (`/cart :: click #buy`), is in
  // the sidecar of a visit to another URL (`/`) — and the same key can be in
  // both, so the slowest must be picked across all of them.
  const withSidecar = report.pages.filter((p) => p.perf && p.perfPage?.reportPath);
  if (withSidecar.length === 0) {
    throw new Error(
      `${reportFile} has no per-page perf report — rerun the crawl with --perf-trace (or --perf-out <dir> plus --perf-trace)`,
    );
  }
  const candidates: DrilldownTarget[] = [];
  let missingTrace = false;
  for (const page of withSidecar) {
    const { path, tried } = resolveSidecar(page.perfPage!.reportPath!, {
      reportFile,
      perfDir,
      reproCommand: report.reproCommand,
    });
    if (!path) {
      throw new Error(
        `per-page perf report ${page.perfPage!.reportPath} not found (tried ${tried.join(", ")}); pass --perf-dir <the crawl's --perf-out>`,
      );
    }
    const sidecar = JSON.parse(readFileSync(path, "utf-8")) as SidecarReport;
    const spans = sidecar.spans.filter((s) => s.key === key);
    if (spans.length === 0) continue;
    if (!sidecar.tracePath) {
      missingTrace = true;
      continue;
    }
    // The trace path is as the crawl wrote it (relative to its cwd); fall
    // back to the file next to the sidecar, where the crawler puts it.
    const trace = [sidecar.tracePath, join(dirname(path), basename(sidecar.tracePath))].find((p) =>
      existsSync(p),
    );
    if (!trace) {
      throw new Error(`trace ${sidecar.tracePath} not found (also looked next to ${path})`);
    }
    for (const span of spans) {
      candidates.push({ span, pageUrl: sidecar.url, sidecarPath: path, tracePath: trace, occurrences: 0 });
    }
  }
  if (candidates.length === 0) {
    throw new Error(
      missingTrace
        ? `"${key}" was measured without a trace — rerun the crawl with --perf-trace`
        : `no per-page perf report holds "${key}"`,
    );
  }
  const slowest = candidates.reduce((a, b) => (b.span.durationMs > a.span.durationMs ? b : a));
  return { ...slowest, occurrences: candidates.length };
}

/** Read a trace file: lightbringer streams a JSON array; DevTools saves `{ traceEvents }`. */
/**
 * Function names of chaosbringer's own in-page code (init scripts and
 * `page.evaluate` helpers). URL-less like every injected script, so without
 * these the drilldown files their samples — and, through the script they
 * share, their anonymous callbacks — as `[native]`. lightbringer already
 * knows its collector's and Playwright's frames.
 */
export const CHAOSBRINGER_HARNESS_FRAMES: readonly string[] = [
  "collectRawLinks",
  "collectRawTargets",
  "installRejectionCapture",
  "chaosbringerSettleProbe",
];

/**
 * The drilldown's "no SelectorStats" hint. lightbringer's says `PERF_CSS=1`,
 * an env var of lightbringer's Playwright fixture that a crawl never reads;
 * a crawl gets SelectorStats from `perf.cssSelectorStats`, which has no CLI
 * flag.
 */
export const CRAWL_SELECTOR_STATS_HINT =
  "crawl with perf: { cssSelectorStats: true }, a programmatic option with no CLI flag,";

function readTrace(path: string): DrilldownTraceEvent[] {
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as
    | DrilldownTraceEvent[]
    | { traceEvents?: DrilldownTraceEvent[] };
  return Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? []);
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const HELP = `Usage: chaosbringer perf <subcommand> [options]

Repeated-run statistics over crawl reports written with --perf. Spans are
grouped by perfKey ("<urlPattern> :: <kind>"); every number is a median over
the reports given, with lightbringer's noise rules.

Subcommands:
  emit-budgets <report.json...> [--headroom 1.25] [--out ${DEFAULT_PERF_BUDGETS_PATH}]
      Budgets per perfKey: ceil(median × headroom) of durationMs, scriptMs,
      blockingMs, layoutCount, recalcStyleMs, encodedKB, requestCount and
      interactionMs. Keys seen in fewer than half the reports are skipped
      (and listed). The reports' settle mode is written into the file.

  gate <report.json...> --budgets <file> [--json]
      Medians vs budgets (an emit-budgets file or a perfBudgets array of
      { match, budget } globs). Exit 1 on a median over budget, or when
      nothing was gated (no reports, no spans, no budget matched); a noisy
      metric whose p75 crosses its budget only warns.

  regress <baselineDir|report.json...> --current <report.json...> [--threshold 0.15] [--json]
      Per-perfKey medians, current vs baseline. A regression needs both the
      relative threshold and the metric's absolute floor; noisy medians warn.
      Exit 1 on a regression.

  emit-budgets, gate and regress refuse (exit 2) inputs crawled under
  different --settle modes: the settle mode changes what a span measures.
  --allow-settle-mismatch compares anyway, with a warning. Reports that do
  not record their mode (older chaosbringer) only warn.
  They also refuse (exit 2) inputs whose perfKeys have different versions
  (perf.keyVersion; absent means 1): version 2 keys an action after a
  navigating click by the page it ran on. --allow-key-mismatch compares
  anyway, with a warning.

  drilldown <report.json> <perfKey> [--top 15] [--perf-dir <dir>]
      Where the span's time went, from its page's trace (crawl with
      --perf-trace). With several spans of that key, the slowest is shown.

Examples:
  for i in 1 2 3 4 5; do chaosbringer --url $URL --seed 42 --perf --output runs/r$i.json; done
  chaosbringer perf emit-budgets runs/*.json
  chaosbringer perf gate pr/*.json --budgets ${DEFAULT_PERF_BUDGETS_PATH}
  chaosbringer perf regress baseline/ --current pr/*.json
  chaosbringer perf drilldown runs/r1.json "/cart :: click #checkout"
`;

function fail(msg: string): void {
  console.error(`perf: ${msg}`);
  process.exitCode = 1;
}

function parseNumber(flag: string, raw: string | undefined, def: number, min: number): number {
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) throw new Error(`${flag} must be a number >= ${min} (got ${JSON.stringify(raw)})`);
  return n;
}

export async function runPerfCli(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    console.log(HELP);
    return;
  }
  switch (sub) {
    case "emit-budgets":
      runEmit(rest);
      return;
    case "gate":
      runGate(rest);
      return;
    case "regress":
      runRegress(rest);
      return;
    case "drilldown":
      runDrilldown(rest);
      return;
    default:
      fail(`unknown subcommand "${sub}" (expected emit-budgets, gate, regress or drilldown)`);
  }
}

function runEmit(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      headroom: { type: "string" },
      out: { type: "string" },
      "allow-settle-mismatch": { type: "boolean", default: false },
      "allow-key-mismatch": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (positionals.length === 0) {
    fail("emit-budgets: expected at least one report path");
    return;
  }
  // Below 1 a budget would sit under the median it was measured from.
  const headroom = parseNumber("--headroom", values.headroom, DEFAULT_BUDGET_HEADROOM, 1);
  const { paths, skipped: skippedFiles } = expandReportPaths(positionals);
  const reports = paths.map(loadCrawlReport);
  if (skippedFiles.length > 0) {
    console.log(`[perf emit-budgets] skipped ${skippedFiles.length} non-report JSON file(s): ${skippedFiles.join(", ")}`);
  }
  // Budgets from mixed modes would be a median of two different measurements.
  const settle = settleGate("emit-budgets", reportSettleSources("reports", paths, reports), values["allow-settle-mismatch"]);
  if (!settle) return;
  // Mixed key versions would median different steps under one key.
  if (!keyVersionGate("emit-budgets", reportKeySources("reports", paths, reports), values["allow-key-mismatch"])) return;
  // Only a mode every report recorded is written: a file claiming one mode
  // for budgets measured partly under another would make gate's check lie.
  const recorded = settle.mismatch || settle.unrecorded.length > 0 ? undefined : settle.agreed;
  const result = emitPerfBudgets(reports, { headroom, ...(recorded ? { settle: recorded } : {}) });
  const out = values.out ?? DEFAULT_PERF_BUDGETS_PATH;
  const n = Object.keys(result.file.budgets).length;
  if (result.skipped.length > 0) {
    console.log(
      `  skipped ${result.skipped.length} key(s) seen in fewer than half the reports:`,
    );
    for (const s of result.skipped) console.log(`    ${s.key}  (${s.seenIn}/${reports.length})`);
  }
  // Checked before writing: an empty result would otherwise overwrite a good
  // budgets file with `{ budgets: {} }`, and a gate on that passes by
  // checking nothing.
  if (n === 0) {
    fail(
      `emit-budgets: no measured spans to budget in ${reports.length} report(s) — were the crawls run with --perf? (${out} left untouched)`,
    );
    return;
  }
  writeFileSync(out, `${JSON.stringify(result.file, null, 2)}\n`);
  console.log(`[perf emit-budgets] ${n} key(s) from ${reports.length} report(s), headroom ×${headroom} → ${out}`);
}

function runGate(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      budgets: { type: "string" },
      json: { type: "boolean", default: false },
      "allow-settle-mismatch": { type: "boolean", default: false },
      "allow-key-mismatch": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (positionals.length === 0) {
    fail("gate: expected at least one report path");
    return;
  }
  if (!values.budgets) {
    fail("gate: --budgets <file> is required");
    return;
  }
  const budgetsJson: unknown = JSON.parse(readFileSync(values.budgets, "utf-8"));
  const rules = perfBudgetRulesFromJson(budgetsJson, values.budgets);
  // The crawler's check: a misspelt metric (`durationMS`) would otherwise be
  // a budget that never fires yet counts as a gated key.
  try {
    validatePerfBudgets(rules);
  } catch (err) {
    fail(`gate: ${values.budgets}: ${err instanceof Error ? err.message : err}`);
    return;
  }
  const { paths, skipped } = expandReportPaths(positionals);
  if (skipped.length > 0 && !values.json) {
    console.log(`[perf gate] skipped ${skipped.length} non-report JSON file(s): ${skipped.join(", ")}`);
  }
  const reports = paths.map(loadCrawlReport);
  // An emit-budgets file records the mode its budgets were measured under;
  // a hand-written perfBudgets array was measured under nothing, so it
  // takes no part in the check (the reports are still checked among themselves).
  const budgetsSources: SettleSource[] =
    budgetsJson !== null && typeof budgetsJson === "object" && !Array.isArray(budgetsJson)
      ? [{ side: "budgets", source: values.budgets, settle: (budgetsJson as Partial<PerfBudgetsFile>).settle }]
      : [];
  if (!settleGate("gate", [...budgetsSources, ...reportSettleSources("reports", paths, reports)], values["allow-settle-mismatch"])) {
    return;
  }
  // A hand-written rules array has no version: its globs are the author's,
  // not keys emitted by a crawl, so only an emitted budgets file is checked.
  const budgetsKeySources: KeyVersionSource[] =
    budgetsJson !== null && typeof budgetsJson === "object" && !Array.isArray(budgetsJson)
      ? [{ side: "budgets", source: values.budgets, keyVersion: (budgetsJson as Partial<PerfBudgetsFile>).keyVersion }]
      : [];
  if (
    !keyVersionGate("gate", [...budgetsKeySources, ...reportKeySources("reports", paths, reports)], values["allow-key-mismatch"])
  ) {
    return;
  }
  const result = gatePerf(reports, rules);
  const { lines, failed } = formatPerfGate(result);
  if (values.json) console.log(JSON.stringify({ ...result, passed: !failed }, null, 2));
  else for (const l of lines) (failed && l.startsWith("[perf gate] FAILED") ? console.error : console.log)(l);
  if (failed) process.exitCode = 1;
}

/**
 * Pull `--current`'s operands out of argv: every argument after `--current`
 * up to the next flag. parseArgs would take only the first and leave the
 * rest as positionals — the baseline side — so `--current pr/*.json` (a
 * shell glob) would silently compare most of the PR against itself.
 */
export function splitCurrentOperands(argv: readonly string[]): { rest: string[]; current: string[] } {
  const rest: string[] = [];
  const current: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--current") {
      while (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) current.push(argv[++i]!);
    } else if (a.startsWith("--current=")) {
      current.push(a.slice("--current=".length));
    } else {
      rest.push(a);
    }
  }
  return { rest, current };
}

function runRegress(argv: string[]): void {
  const split = splitCurrentOperands(argv);
  const { values, positionals } = parseArgs({
    args: split.rest,
    allowPositionals: true,
    options: {
      threshold: { type: "string" },
      json: { type: "boolean", default: false },
      "allow-settle-mismatch": { type: "boolean", default: false },
      "allow-key-mismatch": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (positionals.length === 0) {
    fail("regress: expected a baseline directory or report paths");
    return;
  }
  if (split.current.length === 0) {
    fail("regress: --current <report.json...> is required");
    return;
  }
  const threshold = parseNumber("--threshold", values.threshold, DEFAULT_REGRESS_THRESHOLD, 0);
  const base = expandReportPaths(positionals);
  const cur = expandReportPaths(split.current);
  if (base.paths.length === 0) {
    fail(`regress: no crawl reports in ${positionals.join(", ")}`);
    return;
  }
  // The current side is the one under test: with no reports, or reports
  // that measured nothing, regress would find no regressions and pass.
  if (cur.paths.length === 0) {
    fail(`regress: no crawl reports in --current ${split.current.join(", ")}`);
    return;
  }
  const baseReports = base.paths.map(loadCrawlReport);
  const curReports = cur.paths.map(loadCrawlReport);
  const settleSources = [
    ...reportSettleSources("baseline", base.paths, baseReports),
    ...reportSettleSources("current", cur.paths, curReports),
  ];
  if (!settleGate("regress", settleSources, values["allow-settle-mismatch"])) return;
  const keySources = [
    ...reportKeySources("baseline", base.paths, baseReports),
    ...reportKeySources("current", cur.paths, curReports),
  ];
  if (!keyVersionGate("regress", keySources, values["allow-key-mismatch"])) return;
  const empty = regressNothingMeasured(baseReports, curReports);
  if (empty) {
    fail(`regress: ${empty}`);
    return;
  }
  const result = regressPerf(baseReports, curReports, { threshold });
  const missing = missingKeys(baseReports, curReports);
  if (missing.length > 0 && !values.json) {
    // Not a failure: a random crawl reaches a different set of targets from
    // run to run. Listed so a key that vanished is seen, not ignored.
    console.log(`[regress] ${missing.length} baseline key(s) not measured in current:`);
    for (const k of missing.slice(0, 20)) console.log(`    ${k}`);
    if (missing.length > 20) console.log(`    … and ${missing.length - 20} more`);
  }
  const skipped = [...base.skipped, ...cur.skipped];
  if (values.json) {
    console.log(JSON.stringify({ ...result, missingKeys: missing, skippedFiles: skipped, failed: result.regressions.length > 0 }, null, 2));
  } else {
    const { stdout, stderr } = formatRegress(result, {
      baselineLabel: `${positionals.join(" ")} (${base.paths.length} report(s))`,
      currentLabel: `${cur.paths.length} report(s)`,
    });
    if (skipped.length > 0) stdout.unshift(`[regress] skipped ${skipped.length} non-report JSON file(s): ${skipped.join(", ")}`);
    for (const l of stdout) console.log(l);
    for (const l of stderr) console.error(l);
  }
  if (result.regressions.length > 0) process.exitCode = 1;
}

function runDrilldown(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      top: { type: "string" },
      "perf-dir": { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (positionals.length !== 2) {
    fail("drilldown: expected <report.json> <perfKey>");
    return;
  }
  const [reportFile, key] = positionals as [string, string];
  const topN = Math.floor(parseNumber("--top", values.top, DRILLDOWN_TOP_N, 1));
  const report = loadCrawlReport(reportFile);
  const target = findDrilldownTarget(report, key, { reportFile, perfDir: values["perf-dir"] });
  const analysis = analyseDrilldown(target.span, readTrace(target.tracePath), {
    pageUrl: target.pageUrl,
    topN,
    harnessFrames: CHAOSBRINGER_HARNESS_FRAMES,
  });
  if (target.occurrences > 1) {
    console.log(`(${target.occurrences} spans have this key; showing the slowest)`);
  }
  for (const line of formatDrilldown(analysis, {
    slug: basename(target.sidecarPath, ".json"),
    spanName: target.span.key ?? target.span.name,
    selectorStatsHint: CRAWL_SELECTOR_STATS_HINT,
  })) {
    console.log(line);
  }
}
