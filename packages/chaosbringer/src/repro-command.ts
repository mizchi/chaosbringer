/**
 * The `chaosbringer …` line a failing run prints so the reader can reproduce it.
 *
 * A pure function of the resolved options and the seed: it was a private method
 * reading `this`, which made the one thing a reader most wants to check — that
 * the printed command really does reproduce the run — impossible to test
 * without booting a browser.
 *
 * Only options that differ from the default are emitted, so the line stays
 * short enough to paste.
 */
import { DEFAULT_OPTIONS } from "./defaults.js";
import { PERF_BUDGET_KEYS } from "./types.js";
import type { CrawlerOptions } from "./types.js";

/** Shell-quote a value for inclusion in a reproducible CLI invocation. */
function shellQuote(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_\-:/.=?&@%+,]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function buildReproCommand(
options: Required<CrawlerOptions>,
seed: number,
): string {
  const parts: string[] = ["chaosbringer", "--url", shellQuote(options.baseUrl)];
  parts.push("--seed", String(seed));
  if (options.cdpEndpoint) parts.push("--cdp", shellQuote(options.cdpEndpoint));
  if (options.cdpTargetId) parts.push("--cdp-target", shellQuote(options.cdpTargetId));
  if (options.terminalBrowser) parts.push("--terminal-browser");
  if (options.maxPages !== DEFAULT_OPTIONS.maxPages) {
    parts.push("--max-pages", String(options.maxPages));
  }
  if (options.maxActionsPerPage !== DEFAULT_OPTIONS.maxActionsPerPage) {
    parts.push("--max-actions", String(options.maxActionsPerPage));
  }
  for (const p of options.excludePatterns ?? []) {
    parts.push("--exclude", shellQuote(p));
  }
  for (const p of options.spaPatterns ?? []) {
    parts.push("--spa", shellQuote(p));
  }
  if (options.storageState) {
    parts.push("--storage-state", shellQuote(options.storageState));
  }
  if (options.performanceBudget) {
    const budget = options.performanceBudget;
    const entries = PERF_BUDGET_KEYS.filter((k) => typeof budget[k] === "number")
      .map((k) => `${k}=${budget[k]}`)
      .join(",");
    if (entries.length > 0) parts.push("--budget", entries);
  }
  if (options.traceOut) {
    parts.push("--trace-out", shellQuote(options.traceOut));
  }
  if (options.traceReplay) {
    parts.push("--trace-replay", shellQuote(options.traceReplay));
  }
  if (options.device) {
    parts.push("--device", shellQuote(options.device));
  }
  if (options.network) {
    parts.push("--network", shellQuote(options.network));
  }
  if (options.seedFromSitemap) {
    parts.push("--seed-from-sitemap", shellQuote(options.seedFromSitemap));
  }
  if (options.shardCount !== undefined && options.shardCount > 1) {
    parts.push("--shard", `${options.shardIndex ?? 0}/${options.shardCount}`);
  }
  parts.push(...perfReproFlags(options));
  return parts.join(" ");
}

/**
 * The `--perf*` flags for `perf` / `perfBudgets`, so a repro measures the
 * way the run did: a regression that only shows with GC forced, or a budget
 * that failed, reproduces only with the same flags.
 *
 * `perf.actions: false` has no flag and is left out. `cssSelectorStats` has
 * none either; it implies trace level, which `--perf-trace` does give.
 * Budgets set in code have no file to point at and are omitted like other
 * programmatic-only options; budgets from `--perf-budgets <file>` point back
 * at that file.
 */
export function perfReproFlags(
  options: Pick<CrawlerOptions, "perf" | "perfBudgets" | "perfBudgetsFile">,
): string[] {
  const out: string[] = [];
  // Rules without `perf` turned measurement on (see the crawler), so the
  // repro measures too even when it cannot carry the rules themselves.
  const perf =
    options.perf ?? (options.perfBudgets && options.perfBudgets.length > 0 ? true : undefined);
  if (perf !== undefined && perf !== false) {
    const p = perf === true ? {} : perf;
    const trace = p.level === "trace" || p.cssSelectorStats === true;
    const mem = p.memory?.forceGc === true;
    const cov = p.coverage === true;
    // Every other flag implies --perf; spell it out only when nothing else
    // would. --perf-budgets implies it only with at least one rule (the
    // crawler turns perf on for non-empty rules), so an empty budgets file
    // does not count.
    const budgetsImplyPerf =
      !!options.perfBudgetsFile && !!options.perfBudgets && options.perfBudgets.length > 0;
    if (!trace && !mem && !cov && p.outDir === undefined && !budgetsImplyPerf) {
      out.push("--perf");
    }
    if (trace) out.push("--perf-trace");
    if (mem) out.push("--perf-mem");
    if (cov) out.push("--perf-cov");
    if (p.outDir !== undefined) out.push("--perf-out", shellQuote(p.outDir));
  }
  if (options.perfBudgetsFile) out.push("--perf-budgets", shellQuote(options.perfBudgetsFile));
  return out;
}
