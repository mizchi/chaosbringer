/**
 * The verdicts on one crawl, as lists of problems (`[]` = pass). Pure: they
 * read the report and the invariant counts, so they are unit-tested on
 * synthetic reports (verdict.test.ts) as well as run on real ones.
 *
 *   judgeBuggy     the expected signal, exactly the declared ones, and a failing strict exit
 *   judgeClean     no signal at all, strict exit 0, the page loaded, every check ran
 *   judgeDelivered the data reached the page, by the channel's own evidence
 */

import type { CrawlReport } from "chaosbringer";
import type { CaseData } from "./inject.js";
import type { DataPattern, Signal, Variant } from "./pattern.js";

/** What a crawl reported, in the terms a `Signal` is written in. */
export type ObservedSignal =
  | { kind: "error"; type: string; message: string }
  | { kind: "invariant"; name: string }
  | { kind: "blocked-navigation"; url: string };

/** One crawl of one variant with one kind of data, as `runCase` returns it. */
export interface CaseRun {
  variant: Variant;
  data: CaseData;
  /** The URL the crawl started at, query included. */
  entryUrl: string;
  report: CrawlReport;
  /** `getExitCode(report, true)`. */
  exitCode: number;
  /** `getExitCode(report, false)`: what a run without `strict` would exit with. */
  defaultExit: number;
  signals: ObservedSignal[];
  /** `deliveredOf`: how often the data reached the page. */
  delivered: number;
  /** Times each suite invariant's check ran, by name. */
  invariantRuns: Record<string, number>;
}

/**
 * Every signal in `report`: one per error cluster that isn't an invariant
 * violation, one per failed invariant, one per off-site navigation the
 * crawler blocked. The browser's own error page for a blocked navigation
 * (`chrome-error://chromewebdata/`) is left out: it is where the page ended
 * up, not where it tried to go.
 */
export function signalsOf(report: Pick<CrawlReport, "errorClusters" | "pages">): ObservedSignal[] {
  const out: ObservedSignal[] = [];
  const seen = new Set<string>();
  const add = (s: ObservedSignal) => {
    const key = JSON.stringify(s);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  for (const c of report.errorClusters) {
    if (c.type === "invariant-violation") {
      for (const name of c.invariantNames ?? []) add({ kind: "invariant", name });
    } else {
      add({ kind: "error", type: c.type, message: c.sample.message });
    }
  }
  for (const p of report.pages) {
    for (const url of p.blockedNavigations ?? []) {
      if (!url.startsWith("chrome-error://")) add({ kind: "blocked-navigation", url });
    }
  }
  return out;
}

export function matches(expected: Signal, observed: ObservedSignal): boolean {
  switch (expected.kind) {
    case "error":
      // `search` ignores a global regex's lastIndex.
      return observed.kind === "error" && observed.message.search(expected.message) !== -1;
    case "invariant":
      return observed.kind === "invariant" && observed.name === expected.name;
    case "blocked-navigation":
      return observed.kind === "blocked-navigation" && observed.url.includes(expected.includes);
  }
}

export function describeSignal(s: Signal): string {
  switch (s.kind) {
    case "error":
      return `error ${s.message}`;
    case "invariant":
      return `invariant ${s.name}`;
    case "blocked-navigation":
      return `blocked navigation to *${s.includes}*`;
  }
}

export function describeObserved(s: ObservedSignal): string {
  switch (s.kind) {
    case "error":
      return `${s.type} "${s.message}"`;
    case "invariant":
      return `invariant ${s.name}`;
    case "blocked-navigation":
      return `blocked navigation to ${s.url}`;
  }
}

/**
 * How often the data reached the page, by the channel's own evidence: the
 * response rule's injections, the storage fault's firings, the visited pages
 * whose URL carries the query, the form fills that succeeded. 0 for an
 * oracle entry, which delivers nothing.
 */
export function deliveredOf(
  pattern: DataPattern,
  report: Pick<CrawlReport, "faultInjections" | "lifecycleFaults" | "pages" | "actions">,
  entryUrl: string,
): number {
  const inject = pattern.inject;
  switch (inject.channel) {
    case "response":
      return report.faultInjections?.find((s) => s.rule === `data:${inject.path}`)?.injected ?? 0;
    case "storage":
      return report.lifecycleFaults?.find((s) => s.name === `data:${inject.key}`)?.fired ?? 0;
    case "query": {
      const search = new URL(entryUrl).search;
      return search === "" ? 0 : report.pages.filter((p) => new URL(p.url).search === search).length;
    }
    case "form":
      return report.actions.filter((a) => a.type === "input" && a.success).length;
    case "none":
      return 0;
  }
}

/**
 * The buggy variant on bad data: the expected signal is reported, and the
 * run's signals are exactly it plus `alsoSignals` (an undeclared one fails,
 * and so does a declared one that is missing). An error or invariant signal
 * must also fail the strict exit code; a blocked navigation changes no exit
 * code, so it isn't held to one.
 */
export function judgeBuggy(pattern: DataPattern, run: CaseRun): string[] {
  const expect = pattern.expect;
  if (expect.signal === "none") return ["an oracle entry has no signal to be flagged by"];
  const declared = [expect.signal, ...(expect.alsoSignals ?? [])];
  const problems: string[] = [];
  const saw = run.signals.length ? run.signals.map(describeObserved).join("; ") : "nothing";
  for (const s of declared) {
    if (!run.signals.some((o) => matches(s, o))) problems.push(`expected ${describeSignal(s)}, saw ${saw}`);
  }
  for (const o of run.signals) {
    if (!declared.some((s) => matches(s, o))) problems.push(`undeclared signal: ${describeObserved(o)}`);
  }
  if (expect.signal.kind !== "blocked-navigation" && run.exitCode !== 1) {
    problems.push(`strict exit code ${run.exitCode}, expected 1`);
  }
  return problems;
}

/**
 * A run that must be clean: no signal of any kind, a strict exit of 0, every
 * page loaded, and every suite invariant ran at least once (a check that
 * never ran can't have failed, so its silence proves nothing).
 */
export function judgeClean(_pattern: DataPattern, run: CaseRun): string[] {
  const problems = run.signals.map((s) => `reported ${describeObserved(s)}`);
  if (run.exitCode !== 0) problems.push(`strict exit code ${run.exitCode}, expected 0`);
  if (run.report.pages.length === 0) problems.push("no page was visited");
  for (const p of run.report.pages) {
    if (p.status !== "success") problems.push(`page ${p.url} has status "${p.status}"`);
  }
  const names = Object.keys(run.invariantRuns);
  if (names.length === 0) problems.push("no invariant was counted");
  for (const name of names) {
    if ((run.invariantRuns[name] ?? 0) < 1) problems.push(`invariant ${name} never ran`);
  }
  return problems;
}

/** The data reached the page (see `deliveredOf`); `[]` for an oracle entry. */
export function judgeDelivered(pattern: DataPattern, run: CaseRun): string[] {
  const inject = pattern.inject;
  const n = deliveredOf(pattern, run.report, run.entryUrl);
  if (inject.channel === "none" || n >= 1) return [];
  switch (inject.channel) {
    case "response": {
      const matched = run.report.faultInjections?.find((s) => s.rule === `data:${inject.path}`)?.matched ?? 0;
      return [
        matched === 0
          ? `rule data:${inject.path} never matched: the page did not fetch ${inject.path}`
          : `rule data:${inject.path} matched ${matched} times and injected none`,
      ];
    }
    case "storage":
      return [`lifecycle fault data:${inject.key} never fired`];
    case "query":
      return [`no visited page carries the query of ${run.entryUrl}`];
    case "form":
      return ["no form fill succeeded: the driver never put the value in the page"];
  }
}
