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
import { faults } from "../faults.js";
import { axe } from "../invariants.js";
import { saveReport } from "../reporter.js";
import type { CrawlerEvents, CrawlerOptions, CrawlReport, FaultRule, Invariant, PerfOptions } from "../types.js";
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
import { readSidecarSpans, withSidecarRequests } from "./sidecars.js";

export interface ScanOptions {
  url: string;
  /** Default 20. */
  maxPages?: number;
  /** Default 5. */
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
  chaos: Array<{ fault: ScanFaultKind; pagesVisited: number; faultsInjected: number }>;
  files: ScanFiles;
}

export const DEFAULT_SCAN_DIR = "chaosbringer-scan";
export const DEFAULT_HANG_RELEASE_MS = 8000;

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
    maxPages: options.maxPages ?? 20,
    maxActionsPerPage: options.maxActionsPerPage ?? 5,
    seed,
    invariants,
    perf: { coverage: options.coverage ?? true, ...options.perf, outDir: perfDir },
  });
  const events = (phase: string): CrawlerEvents => ({
    onPageComplete: (p) => log(`[${phase}] ${p.status} ${p.url}${p.errors.length ? ` (${p.errors.length} errors)` : ""}`),
  });

  const perfDir = join(outDir, "perf");
  log(`[scan] clean crawl of ${options.url} (seed ${seed})`);
  const baseline = await new ChaosCrawler(base(join(perfDir, "clean")), events("clean")).start();
  const baselinePath = join(outDir, "clean-report.json");
  saveReport(baseline, baselinePath);

  // Analysed with the sidecars' full request lists; saved as the crawl wrote it.
  const cleanFull = withSidecarRequests(baseline, readSidecarSpans(baseline, join(perfDir, "clean")));
  const endpoints = deriveScanEndpoints(cleanFull);
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
      const path = join(outDir, `chaos-${kind}-report.json`);
      saveReport(report, path);
      chaos.push({ fault: kind, report: withSidecarRequests(report, readSidecarSpans(report, join(perfDir, kind))) });
      chaosFiles[kind] = path;
    }
  } else if (kinds.length > 0) {
    log("[scan] chaos crawls skipped: no same-site fetch / XHR request seen");
  }

  const analysis = analyzeScan(cleanFull, chaos, { hangReleaseMs, ...(pattern ? { endpointPattern: pattern } : {}) });
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
