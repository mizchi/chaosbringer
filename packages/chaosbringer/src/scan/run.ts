/**
 * `runScan`: one command that sweeps an unknown site for bugs and slow
 * spots. Three steps:
 *
 * 1. **Clean crawl** with `perf` (and JS/CSS coverage) on: errors, broken
 *    pages, Web Vitals, and the per-step cost of every load and action.
 * 2. **Chaos crawls** (unless `chaos: false`): the same seed and pages
 *    again, once per fault kind, with every request to the site's own API —
 *    the fetch / XHR endpoints step 1 saw — answering HTTP 500, failing at
 *    the network level, or never answering. Every request, not a random
 *    share: a small site may call an endpoint once per crawl, and a roll
 *    that misses it finds nothing. What breaks only here is missing
 *    failure handling.
 * 3. **Analyze** the reports (`analyzeScan`) into ranked findings, written
 *    as `scan-report.json` and `scan-report.md`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChaosCrawler } from "../crawler.js";
import { DEFAULT_ACTION_WEIGHTS, DEFAULT_OPTIONS } from "../defaults.js";
import { faults } from "../faults.js";
import { axe } from "../invariants.js";
import { attachHint } from "../browser-bind.js";
import { saveReport } from "../reporter.js";
import { formatReproFlags, ignoreReproFlags, withUnreplayedNote } from "../repro-command.js";
import { PERF_BUDGET_KEYS } from "../types.js";
import type { ActionWeights, CrawlerEvents, CrawlerOptions, CrawlReport, FaultRule, Invariant, PerfOptions, ReproFlag } from "../types.js";
import {
  analyzeScan,
  SCAN_FAULT_KINDS,
  SCAN_FAULT_NAMES,
  type ScanAnalysis,
  type ScanChaosRun,
  type ScanFaultKind,
} from "./analyze.js";
import { deriveScanEndpoints, endpointsPattern, type ScanEndpoint } from "./endpoints.js";
import { formatScanMarkdown, type ScanSummaryInput } from "./format.js";
import { blockedResponses, markServed, probeServed } from "./blocked-responses.js";
import { readSidecarSpans, withSidecarRequests } from "./sidecars.js";

export interface ScanOptions {
  url: string;
  /** Default 20 (`DEFAULT_SCAN_MAX_PAGES`). */
  maxPages?: number;
  /** Default 5 (`DEFAULT_SCAN_MAX_ACTIONS`). */
  maxActionsPerPage?: number;
  /** Where every file goes. Default `chaosbringer-scan`. */
  outDir?: string;
  /** Run the chaos crawls. Default true. */
  chaos?: boolean;
  /** Which chaos crawls to run, one crawl each. Default all: `status` (HTTP 500), `abort`, `hang`. */
  faults?: readonly ScanFaultKind[];
  /** Seed shared by every crawl, so they choose the same actions. Default: random. */
  seed?: number;
  /** Run axe-core on every page (needs `axe-core` installed). Default false. */
  axe?: boolean;
  /** Collect JS / CSS coverage for the unused-code finding. Default true. */
  coverage?: boolean;
  /** Further `perf` options for every crawl (e.g. `memory: { forceGc: true }`); `outDir` is the scan's. */
  perf?: Omit<PerfOptions, "outDir">;
  /** How long the hang crawl holds a request before failing it (ms). Default 8000. */
  hangReleaseMs?: number;
  /**
   * Any other crawler options (`excludePatterns`, `ignoreErrorPatterns`,
   * `storageState`, `headless`, `timeout`, `device`, `network`, …), applied
   * to every crawl. `perf`, `faultInjection`, `seed` and `baseUrl` are the
   * scan's own.
   */
  crawler?: Omit<CrawlerOptions, "baseUrl" | "perf" | "faultInjection" | "seed" | "maxPages" | "maxActionsPerPage">;
  /** Progress callback: one line per phase and page. */
  onProgress?: (line: string) => void;
}

export interface ScanFiles {
  json: string;
  markdown: string;
  baseline: string;
  /** One report per chaos crawl that ran. */
  chaos: Partial<Record<ScanFaultKind, string>>;
  perfDir: string;
}

export interface ScanResult {
  analysis: ScanAnalysis;
  baseline: CrawlReport;
  /** The chaos crawls that ran; empty with `chaos: false` or when no endpoint was found. */
  chaos: ScanChaosRun[];
  endpoints: ScanEndpoint[];
  files: ScanFiles;
}

/** The JSON file `runScan` writes. */
export interface ScanReportFile extends ScanAnalysis {
  url: string;
  startedAt: string;
  durationMs: number;
  seed: number;
  pagesVisited: number;
  endpoints: ScanEndpoint[];
  /** `reproCommand` is the crawl's report's: the `chaosbringer scan` command that reruns it (`scanReproCommand`). */
  chaos: Array<{ fault: ScanFaultKind; pagesVisited: number; faultsInjected: number; reproCommand: string }>;
  files: ScanFiles;
}

export const DEFAULT_SCAN_DIR = "chaosbringer-scan";
export const DEFAULT_HANG_RELEASE_MS = 8000;
export const DEFAULT_SCAN_MAX_PAGES = 20;
export const DEFAULT_SCAN_MAX_ACTIONS = 5;

/**
 * The `chaosbringer scan` command that reruns the chaos crawl for `kind`,
 * which `runScan` puts in that crawl's report as its `reproCommand`. The
 * crawl's own command was a plain `chaosbringer` crawl with no flag for the
 * scan's fault rule: it reran clean and passed, while the report it came
 * from had a high finding. The scan finds the endpoints to fail from its
 * clean crawl, so the command reruns that too, then only this fault.
 *
 * Every scan flag that shapes the crawls or their findings is carried;
 * `scan-repro.test.ts` holds the list. Left out: `--out` and the flags that
 * only change what is shown (`--quiet`, `--no-headless`, `--bind`), and
 * `--fail-on`, which sets the exit code from the findings. What the options
 * set in code (`crawler.invariants`, the other fault layers) ends the
 * command as a comment, as in `buildReproCommand`, and so does every other
 * option that shapes the crawls and has no scan flag (`scanUnflaggedOptions`):
 * `crawler.spaPatterns`, a HAR replay, `perf.memory`, … The plain crawl's
 * command carried several as flags (`--spa`, `--har-replay`), and this one
 * dropped them without a word.
 */
export function scanReproCommand(options: ScanOptions, seed: number, kind: ScanFaultKind): string {
  const c = options.crawler ?? {};
  const flags: ReproFlag[] = [
    { flag: "--url", value: options.url },
    { flag: "--seed", value: String(seed) },
  ];
  const push = (flag: string, value?: string) => flags.push(value === undefined ? { flag } : { flag, value });
  if (options.maxPages !== undefined && options.maxPages !== DEFAULT_SCAN_MAX_PAGES) push("--max-pages", String(options.maxPages));
  if (options.maxActionsPerPage !== undefined && options.maxActionsPerPage !== DEFAULT_SCAN_MAX_ACTIONS) {
    push("--max-actions", String(options.maxActionsPerPage));
  }
  push("--faults", kind === "status" ? "500" : kind);
  // Only the hang crawl holds a request.
  if (kind === "hang" && options.hangReleaseMs !== undefined && options.hangReleaseMs !== DEFAULT_HANG_RELEASE_MS) {
    push("--hang-ms", String(options.hangReleaseMs));
  }
  if (options.axe) push("--axe");
  if (c.ariaTargets) push("--aria-targets");
  if (options.coverage === false) push("--no-coverage");
  for (const p of c.excludePatterns ?? []) push("--exclude", p);
  flags.push(...ignoreReproFlags(c.ignoreErrorPatterns ?? []));
  if (c.seedFromSitemap) push("--sitemap", c.seedFromSitemap);
  if (c.storageState) push("--storage-state", c.storageState);
  if (c.network) push("--network", c.network);
  if (c.device) push("--device", c.device);
  if (c.timeout !== undefined && c.timeout !== DEFAULT_OPTIONS.timeout) push("--timeout", String(c.timeout));
  return withUnreplayedNote(["chaosbringer", "scan", ...formatReproFlags(flags)].join(" "), c, scanUnflaggedOptions(options));
}

type ScanCrawlerOptions = NonNullable<ScanOptions["crawler"]>;
type ScanPerfOptions = NonNullable<ScanOptions["perf"]>;

/**
 * What `scanReproCommand` does with each crawler option `runScan` takes:
 * `"flag"`, a scan flag carries it; `"note"`, `unreplayedNote` counts it
 * already (the fault layers, the invariants); `"output"`, it only changes
 * what is shown or written; else a test of the value set, true when it
 * changes the crawls from what the scan does without it. No scan flag
 * carries those, so the command's note names them. Every option has an
 * entry, so a new one does not compile until it gets one.
 */
const SCAN_CRAWLER_REPRO: {
  [K in keyof ScanCrawlerOptions]-?: "flag" | "note" | "output" | ((value: NonNullable<ScanCrawlerOptions[K]>) => boolean);
} = {
  timeout: "flag",
  excludePatterns: "flag",
  ignoreErrorPatterns: "flag",
  ariaTargets: "flag",
  seedFromSitemap: "flag",
  storageState: "flag",
  network: "flag",
  device: "flag",
  invariants: "note",
  lifecycleFaults: "note",
  runtimeFaults: "note",
  iframeFaults: "note",
  headless: "output",
  bind: "output",
  screenshots: "output",
  screenshotDir: "output",
  logFile: "output",
  logLevel: "output",
  logToConsole: "output",
  recoveryHistorySize: "output",
  failureArtifacts: "output",
  traceOut: "output",
  // What the main CLI sets for its own repro command.
  cliReproFlags: "output",
  perfBudgetsFile: "output",
  // `runScan` settles adaptively unless told otherwise.
  settle: (v) => v !== "adaptive",
  spaPatterns: (v) => v.length > 0,
  // Recording only writes a file.
  har: (v) => v.mode === "replay",
  performanceBudget: (v) => PERF_BUDGET_KEYS.some((k) => typeof v[k] === "number"),
  perfBudgets: (v) => v.length > 0,
  httpCache: (v) => v === false,
  blockExternalNavigation: (v) => v === false,
  enableRecovery: (v) => v === false,
  viewport: (v) => v.width !== DEFAULT_OPTIONS.viewport.width || v.height !== DEFAULT_OPTIONS.viewport.height,
  userAgent: (v) => v !== "",
  actionWeights: (v) => Object.entries(v).some(([k, w]) => w !== undefined && w !== DEFAULT_ACTION_WEIGHTS[k as keyof ActionWeights]),
  initScripts: (v) => v.length > 0,
  traceparent: (v) => v !== false,
  coverageFeedback: (v) => v.enabled,
  launchOptions: (v) => Object.keys(v).length > 0,
  cdpEndpoint: () => true,
  cdpTargetId: () => true,
  terminalBrowser: (v) => v,
  traceReplay: () => true,
  shardCount: (v) => v > 1,
  // Only with `shardCount`, which is named.
  shardIndex: () => false,
  advisor: () => true,
  driver: () => true,
  driverGoal: () => true,
  server: () => true,
};

/** `SCAN_CRAWLER_REPRO`'s tests for `perf`: no scan flag carries any of it. */
const SCAN_PERF_REPRO: {
  [K in keyof ScanPerfOptions]-?: (value: NonNullable<ScanPerfOptions[K]>, options: ScanOptions) => boolean;
} = {
  level: (v) => v === "trace",
  memory: (v) => v.forceGc === true,
  // `--no-coverage` carries `coverage`, which this one overrides (`runScan`).
  coverage: (v, o) => v !== (o.coverage ?? true),
  cssSelectorStats: (v) => v,
  actions: (v) => v === false,
};

/**
 * The options set in `options` that change the crawls and that no scan flag
 * carries, as `crawler.<name>` / `perf.<name>`; `scanReproCommand` names
 * them in its note.
 */
export function scanUnflaggedOptions(options: ScanOptions): string[] {
  const names: string[] = [];
  const crawler: Record<string, unknown> = options.crawler ?? {};
  for (const [key, how] of Object.entries(SCAN_CRAWLER_REPRO)) {
    const value = crawler[key];
    if (typeof how === "function" && value !== undefined && (how as (v: unknown) => boolean)(value)) names.push(`crawler.${key}`);
  }
  const perf: Record<string, unknown> = options.perf ?? {};
  for (const [key, changes] of Object.entries(SCAN_PERF_REPRO)) {
    const value = perf[key];
    if (value !== undefined && (changes as (v: unknown, o: ScanOptions) => boolean)(value, options)) names.push(`perf.${key}`);
  }
  return names;
}

/** The one rule of the chaos crawl for `kind`: every API request gets the fault. */
export function scanFaultRule(kind: ScanFaultKind, urlPattern: string, hangReleaseMs: number): FaultRule {
  const name = SCAN_FAULT_NAMES[kind];
  // What the page's code requests, never a document it navigates to: a route
  // whose data is fetched from its own URL shares that URL with its page.
  const resourceTypes = ["fetch", "xhr"];
  switch (kind) {
    case "status":
      return faults.status(500, {
        urlPattern,
        name,
        resourceTypes,
        body: '{"error":"injected by chaosbringer scan"}',
        contentType: "application/json",
      });
    case "abort":
      return faults.abort({ urlPattern, name, resourceTypes });
    case "hang":
      return faults.hang({ urlPattern, name, resourceTypes, releaseAfterMs: hangReleaseMs });
  }
}

export async function runScan(options: ScanOptions): Promise<ScanResult> {
  const outDir = options.outDir ?? DEFAULT_SCAN_DIR;
  const started = Date.now();
  const seed = options.seed ?? Math.floor(Math.random() * 2 ** 31);
  const log = options.onProgress ?? (() => {});
  const hangReleaseMs = options.hangReleaseMs ?? DEFAULT_HANG_RELEASE_MS;
  const kinds = options.chaos === false ? [] : [...new Set(options.faults ?? SCAN_FAULT_KINDS)];
  mkdirSync(outDir, { recursive: true });

  const invariants: Invariant[] = [...(options.crawler?.invariants ?? [])];
  if (options.axe) invariants.push(axe());

  const base = (perfDir: string): CrawlerOptions => ({
    // Adaptive settle: an unknown site often never reaches networkidle
    // (analytics, polling), and the adaptive cap counts those pages.
    settle: "adaptive",
    ...options.crawler,
    baseUrl: options.url,
    maxPages: options.maxPages ?? DEFAULT_SCAN_MAX_PAGES,
    maxActionsPerPage: options.maxActionsPerPage ?? DEFAULT_SCAN_MAX_ACTIONS,
    seed,
    invariants,
    // The clean crawl's repro is a plain crawl, which builds the same check from --axe.
    ...(options.axe ? { cliReproFlags: [...(options.crawler?.cliReproFlags ?? []), { flag: "--axe" }] } : {}),
    perf: { coverage: options.coverage ?? true, ...options.perf, outDir: perfDir },
  });
  const events = (phase: string): CrawlerEvents => ({
    onPageComplete: (p) => log(`[${phase}] ${p.status} ${p.url}${p.errors.length ? ` (${p.errors.length} errors)` : ""}`),
    onBind: (b) => log(`[${phase}] ${attachHint(b)}`),
  });

  const perfDir = join(outDir, "perf");
  log(`[scan] clean crawl of ${options.url} (seed ${seed})`);
  const baseline = await new ChaosCrawler(base(join(perfDir, "clean")), events("clean")).start();
  const baselinePath = join(outDir, "clean-report.json");
  saveReport(baseline, baselinePath);

  // Analysed with the sidecars' full request lists; saved as the crawl wrote it.
  const cleanFull = withSidecarRequests(baseline, readSidecarSpans(baseline, join(perfDir, "clean")));
  const endpoints = deriveScanEndpoints(cleanFull, { exclude: options.crawler?.excludePatterns });
  const pattern = endpointsPattern(endpoints);
  const chaos: ScanChaosRun[] = [];
  const chaosFiles: ScanFiles["chaos"] = {};
  if (kinds.length > 0 && pattern) {
    for (const kind of kinds) {
      log(`[scan] chaos crawl: ${SCAN_FAULT_NAMES[kind]} on ${endpoints.length} endpoint(s)`);
      const report = await new ChaosCrawler(
        { ...base(join(perfDir, kind)), faultInjection: [scanFaultRule(kind, pattern, hangReleaseMs)] },
        events(kind),
      ).start();
      report.reproCommand = scanReproCommand(options, seed, kind);
      const path = join(outDir, `chaos-${kind}-report.json`);
      saveReport(report, path);
      chaos.push({ fault: kind, report: withSidecarRequests(report, readSidecarSpans(report, join(perfDir, kind))) });
      chaosFiles[kind] = path;
    }
  } else if (kinds.length > 0) {
    log("[scan] chaos crawls skipped: no same-site fetch / XHR request seen");
  }

  // Responses the browser refused that are fine when fetched directly: see
  // `blocked-responses.ts`.
  const blocked = blockedResponses([cleanFull, ...chaos.map((c) => c.report)]);
  const served = blocked.length > 0 ? await probeServed(blocked) : new Set<string>();
  const analysis = analyzeScan(
    markServed(cleanFull, served),
    chaos.map((c) => ({ ...c, report: markServed(c.report, served) })),
    { hangReleaseMs, ...(pattern ? { endpointPattern: pattern } : {}) },
  );
  const files: ScanFiles = {
    json: join(outDir, "scan-report.json"),
    markdown: join(outDir, "scan-report.md"),
    baseline: baselinePath,
    chaos: chaosFiles,
    perfDir,
  };
  const startedAt = new Date(started).toISOString();
  const durationMs = Date.now() - started;
  const chaosSummary = chaos.map(({ fault, report }) => ({
    fault,
    pagesVisited: report.pagesVisited,
    faultsInjected: (report.faultInjections ?? []).reduce((n, s) => n + s.injected, 0),
    reproCommand: report.reproCommand,
  }));
  const file: ScanReportFile = {
    url: options.url,
    startedAt,
    durationMs,
    seed,
    pagesVisited: baseline.pagesVisited,
    endpoints,
    chaos: chaosSummary,
    files,
    ...analysis,
  };
  writeFileSync(files.json, JSON.stringify(file, null, 2));
  const summary: ScanSummaryInput = {
    url: options.url,
    startedAt,
    durationMs,
    pagesVisited: baseline.pagesVisited,
    actions: baseline.actions.length,
    chaos: kinds.length > 0 ? { runs: chaosSummary, endpoints } : undefined,
    files,
  };
  writeFileSync(files.markdown, formatScanMarkdown(analysis, summary));
  return { analysis, baseline, chaos, endpoints, files };
}
