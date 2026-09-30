/**
 * The crawl report keeps the five slowest requests of each span; the
 * per-page perf sidecars keep up to twenty. The scan's request rules
 * (duplicates, per-item fan-out, repeat downloads, endpoint discovery) need
 * the fuller lists, so the scan puts them back into a copy of the report
 * before analysing it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CrawlReport, PerfSpanReport } from "../types.js";

type Requests = PerfSpanReport["network"]["requests"];

/** Every sidecar span of a crawl, in page order: `{ key, requests }`. */
export function readSidecarSpans(report: CrawlReport, perfDir: string): Array<{ key: string; requests: Requests }> {
  const out: Array<{ key: string; requests: Requests }> = [];
  for (const p of report.pages) {
    const rel = p.perfPage?.reportPath;
    if (!rel) continue;
    const path = join(perfDir, rel);
    if (!existsSync(path)) continue;
    try {
      const sidecar = JSON.parse(readFileSync(path, "utf-8")) as {
        spans?: Array<{ key?: string; network?: { requests?: Requests } }>;
      };
      for (const s of sidecar.spans ?? []) {
        if (s.key && s.network?.requests) out.push({ key: s.key, requests: s.network.requests });
      }
    } catch {
      // A sidecar only adds detail; the report's own lists still stand.
    }
  }
  return out;
}

/**
 * A copy of `report` whose spans carry the sidecars' request lists. Spans
 * are matched by perfKey, in order: the sidecars list a key's spans in the
 * order the crawl ran them, and so do `pages` and `actions`. A span with no
 * sidecar match keeps its own list, and a sidecar list is used only when it
 * is at least as long as the report's (it is the same list, uncut).
 */
export function withSidecarRequests(
  report: CrawlReport,
  sidecarSpans: ReadonlyArray<{ key: string; requests: Requests }>,
): CrawlReport {
  if (sidecarSpans.length === 0) return report;
  const queues = new Map<string, Requests[]>();
  for (const s of sidecarSpans) {
    const q = queues.get(s.key) ?? [];
    q.push(s.requests);
    queues.set(s.key, q);
  }
  const hydrate = (span: PerfSpanReport | undefined): PerfSpanReport | undefined => {
    if (!span) return span;
    const full = queues.get(span.key)?.shift();
    if (!full || full.length < span.network.requests.length) return span;
    return { ...span, network: { ...span.network, requests: full } };
  };
  // Loads first, then actions, as each page's sidecar lists them: a page's
  // load always precedes its own actions, and keys of loads and actions
  // never collide (`:: load` vs `:: <action>`), so the two passes cannot
  // take each other's entries.
  const pages = report.pages.map((p) => (p.perf ? { ...p, perf: hydrate(p.perf) } : p));
  const actions = report.actions.map((a) => (a.perf ? { ...a, perf: hydrate(a.perf) } : a));
  return { ...report, pages, actions };
}
