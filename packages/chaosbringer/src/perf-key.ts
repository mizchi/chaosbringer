/**
 * Pure helpers for per-step performance measurement: the stable span key,
 * span names, option normalisation and the report-size trimming. Kept apart
 * from `perf.ts` — which drives a browser — so every rule that decides what a
 * key or a report looks like is unit-testable without launching one.
 */

import type { SpanReport } from "lightbringer/core";
import { normalizeUrl } from "./filters.js";
import type { ActionResult, PerfOptions, PerfSpanReport } from "./types.js";

/**
 * Collapse one path segment that is an identifier rather than a route name.
 * Three shapes cover the ids real apps put in URLs: database row numbers,
 * UUIDs, and long hex digests (Mongo ObjectIds, content hashes). A shorter
 * hex segment is left alone because short words like `cafe` or `add` are
 * valid hex too, and collapsing those would merge routes that differ.
 */
function collapseSegment(segment: string): string {
  if (/^\d+$/.test(segment)) return ":id";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ":id";
  if (/^[0-9a-f]{16,}$/i.test(segment)) return ":id";
  return segment;
}

/**
 * The route a URL belongs to, for grouping measurements across runs.
 *
 * Only the pathname survives. The origin is dropped because a baseline taken
 * against `localhost:3000` has to match a PR run against `localhost:41873`;
 * the query and hash are dropped because they carry state (filters, cache
 * busters, tokens) rather than identify a screen. Path segments that are ids
 * become `:id`, so `/items/17` and `/items/42` are one route with one budget.
 * The URL goes through the crawler's own `normalizeUrl` first, so trailing
 * slashes group exactly the way the visited set does.
 */
export function urlPattern(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(normalizeUrl(url)).pathname;
  } catch {
    // Not an absolute URL. Strip what would have been the query and hash by
    // hand rather than put them in a key that is supposed to be stable.
    pathname = url.split(/[?#]/, 1)[0] || "/";
  }
  return pathname.split("/").map(collapseSegment).join("/") || "/";
}

/**
 * What an action did, for its key and span name: `<type> <selector ?? target>`.
 *
 * A scroll has no selector and its target is the random offset it scrolled to
 * (`scrollY: 523`), which would give every scroll its own key; it is keyed as
 * plain `scroll`. The fill value an `input` wrote, and the option a `select`
 * chose, never appear here: neither `selector` nor `target` carries them.
 */
export function actionKind(action: Pick<ActionResult, "type" | "selector" | "target">): string {
  if (action.type === "scroll" && !action.selector) return "scroll";
  const what = action.selector ?? action.target;
  return what ? `${action.type} ${what}` : action.type;
}

/** The span key budgets and baselines join on: `<urlPattern> :: <kind>`. */
export function perfKey(url: string, kind: string): string {
  return `${urlPattern(url)} :: ${kind}`;
}

/** Span name for a page load: `load <path>`, the real path rather than the pattern. */
export function loadSpanName(url: string): string {
  try {
    return `load ${new URL(url).pathname}`;
  } catch {
    return `load ${url}`;
  }
}

/** `perf` with every default filled in. */
export interface ResolvedPerfOptions {
  level: "light" | "trace";
  memGc: boolean;
  coverage: boolean;
  cssSelectorStats: boolean;
  outDir?: string;
  actions: boolean;
}

/**
 * Where a trace goes when `level: "trace"` is on and no `outDir` was given. A
 * trace is streamed to disk while it is recorded, so it needs a path whether
 * or not the caller asked for artefacts.
 */
export const DEFAULT_PERF_TRACE_DIR = "chaosbringer-perf";

/**
 * Resolve the `perf` option, or `null` when measurement is off. `true` is
 * `{ level: "light" }`; `false` and `undefined` are off. `cssSelectorStats`
 * is recorded into a trace, so it implies `level: "trace"`, and a trace needs
 * a directory, so trace level without `outDir` gets the default one.
 */
export function resolvePerfOptions(perf: boolean | PerfOptions | undefined): ResolvedPerfOptions | null {
  if (perf === undefined || perf === false) return null;
  const opts: PerfOptions = perf === true ? {} : perf;
  const cssSelectorStats = opts.cssSelectorStats ?? false;
  const level = cssSelectorStats ? "trace" : (opts.level ?? "light");
  const outDir = opts.outDir ?? (level === "trace" ? DEFAULT_PERF_TRACE_DIR : undefined);
  return {
    level,
    memGc: opts.memory?.forceGc ?? false,
    coverage: opts.coverage ?? false,
    cssSelectorStats,
    ...(outDir !== undefined ? { outDir } : {}),
    actions: opts.actions ?? true,
  };
}

/** How many entries each per-span list keeps in the crawl report. */
export const PERF_REPORT_LIST_CAP = 5;

/**
 * A lightbringer span as it goes into the crawl report: keyed, renamed, and
 * with its per-request lists capped.
 *
 * lightbringer keeps up to 20 requests per span. On a 500-page crawl with
 * five actions a page that is most of the report, so the report keeps the
 * top five of each list (lightbringer sorts requests slowest first and
 * initiators / domains heaviest first) and the full
 * span stays in the per-page sidecar under `outDir`. The totals —
 * `requestCount`, `encodedKB` — are computed before trimming and still count
 * everything. The declared `budget` is dropped: the crawler declares none.
 */
export function toPerfSpanReport(span: SpanReport, key: string, name: string): PerfSpanReport {
  const { budget: _budget, ...rest } = span;
  void _budget;
  const network = span.network;
  return {
    ...rest,
    name,
    key,
    network: {
      ...network,
      requests: network.requests.slice(0, PERF_REPORT_LIST_CAP),
      byInitiator: network.byInitiator.slice(0, PERF_REPORT_LIST_CAP),
      thirdParty: {
        ...network.thirdParty,
        byDomain: network.thirdParty.byDomain.slice(0, PERF_REPORT_LIST_CAP),
      },
    },
  };
}

/**
 * File name stem for a page's sidecar report: the run's id, then the page's
 * index, then its route pattern, with everything outside `[A-Za-z0-9_-]`
 * squashed. The index keeps two visits to one route in one run apart and
 * sorts a run's files in crawl order; the run id keeps two runs apart, since
 * every crawler numbers its pages from 0 and the Playwright fixture builds
 * one crawler per test into the same `outDir`.
 */
export function perfSlug(url: string, pageIndex: number, runId: string): string {
  const route = urlPattern(url)
    .replace(/:id/g, "id")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${runId}-${String(pageIndex).padStart(3, "0")}-${route || "root"}`;
}

/** The `--perf*` CLI flags, as `parseArgs` hands them over. */
export interface PerfCliFlags {
  perf?: boolean;
  "perf-trace"?: boolean;
  "perf-mem"?: boolean;
  "perf-cov"?: boolean;
  "perf-out"?: string;
}

/**
 * Map the `--perf*` flags onto `CrawlerOptions.perf`. Every flag implies
 * `--perf`: a `--perf-trace` that did nothing without a second flag would be
 * read as "the trace was empty". No flag at all leaves `perf` unset.
 */
export function perfOptionsFromCliFlags(flags: PerfCliFlags): boolean | PerfOptions | undefined {
  const trace = flags["perf-trace"] === true;
  const mem = flags["perf-mem"] === true;
  const cov = flags["perf-cov"] === true;
  const outDir = flags["perf-out"];
  if (!flags.perf && !trace && !mem && !cov && outDir === undefined) return undefined;
  if (!trace && !mem && !cov && outDir === undefined) return true;
  return {
    ...(trace ? { level: "trace" as const } : {}),
    ...(mem ? { memory: { forceGc: true } } : {}),
    ...(cov ? { coverage: true } : {}),
    ...(outDir !== undefined ? { outDir } : {}),
  };
}
