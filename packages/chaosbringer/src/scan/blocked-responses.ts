/**
 * Responses the browser refused that the scan caused, told apart from the
 * ones the site did.
 *
 * Two refusals, both of a cross-origin `no-cors` load (an `<img>`, a
 * `<script>` of another host):
 *
 * - `net::ERR_BLOCKED_BY_ORB`: Opaque Response Blocking stops a response that
 *   does not look like the image, media, script or stylesheet it was
 *   requested as, so it is often the site's bug: webscraper.io's blog image
 *   answered 403 with an XML error body. But Chromium also blocks, now and
 *   then, a file that is fine while the page's requests are intercepted, and
 *   the crawler intercepts every request (fault injection, traceparent, the
 *   external-navigation guard). jquery.com's team page lost gravatar avatars
 *   that way (200 image/jpeg when fetched), and astro.build its Fathom script
 *   (200 application/javascript); neither reproduced in a plain page.
 * - `net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`: the response carried
 *   `Cross-Origin-Resource-Policy: same-origin`. A file that always sends it
 *   cannot be embedded, which is the site's bug; but eslint.org's ad server
 *   sends it only with the 403 it answers a `HeadlessChrome` user agent, the
 *   scanning browser's, and serves the script to everyone else.
 *
 * So after the crawls, each refused URL is fetched once outside the browser.
 * One that is served fine (see `servedFine`) is the scan's doing: its errors
 * are relabelled so the analysis reports them as an environment note rather
 * than a finding. One that fails, or answers anything else, stays.
 */

import { clusterErrors } from "../clusters.js";
import type { CrawlReport, PageError } from "../types.js";

/** The refusals probed, by their `net::ERR_*` code. */
export type BlockedCode = "net::ERR_BLOCKED_BY_ORB" | "net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin";

const BLOCKED_ERROR = /^(\S+) - (net::ERR_BLOCKED_BY_ORB|net::ERR_BLOCKED_BY_RESPONSE\.NotSameOrigin)$/;

/**
 * Chrome's console echo of a refusal. It names no URL, so it is relabelled
 * only on a page where every refusal with its code was.
 */
const BLOCKED_ECHO = /^Failed to load resource: (net::ERR_BLOCKED_BY_ORB|net::ERR_BLOCKED_BY_RESPONSE\.NotSameOrigin)$/;

/** Appended to a relabelled error; `ENVIRONMENT_CAUSES` matches it. */
export const SERVED_NOTE = "(served fine when fetched directly)";

/** How many URLs are fetched at most (one per code, origin and path). */
const PROBE_CAP = 20;

/** Types ORB lets through: images, media, fonts, scripts and stylesheets. */
const ORB_SAFE = /^(?:image|video|audio|font)\/|^(?:text|application)\/(?:x-)?(?:javascript|ecmascript)\b|^text\/css\b/;

export interface BlockedResponse {
  url: string;
  code: BlockedCode;
}

/** The distinct refused responses in any of the reports. */
export function blockedResponses(reports: readonly Pick<CrawlReport, "pages">[]): BlockedResponse[] {
  const seen = new Map<string, BlockedResponse>();
  for (const r of reports) {
    for (const p of r.pages) {
      for (const e of p.errors) {
        const b = blockedResponse(e);
        if (b) seen.set(key(b), b);
      }
    }
  }
  return [...seen.values()];
}

/**
 * Whether a direct fetch shows the browser need not have refused the
 * response: a 2xx that ORB lets through, or a 2xx without a
 * `Cross-Origin-Resource-Policy` that keeps other sites out.
 */
function servedFine(code: BlockedCode, res: Response): boolean {
  if (!res.ok) return false;
  if (code === "net::ERR_BLOCKED_BY_ORB") return ORB_SAFE.test(res.headers.get("content-type") ?? "");
  return !/^same-(?:origin|site)$/i.test((res.headers.get("cross-origin-resource-policy") ?? "").trim());
}

/**
 * The responses among `blocked` that are served fine when fetched directly,
 * as `key`s. A network error, a timeout or any other answer leaves one out,
 * so its errors stay findings.
 *
 * One URL is fetched per code, origin and path, and its answer stands for
 * every query of that path: eslint.org's ad requests differ only in random
 * ids, one per page view, and would use up the cap on their own.
 */
export async function probeServed(
  blocked: readonly BlockedResponse[],
  { fetchImpl = fetch, timeoutMs = 10_000 }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<Set<string>> {
  const groups = new Map<string, BlockedResponse[]>();
  for (const b of blocked) {
    const g = groupKey(b);
    groups.set(g, [...(groups.get(g) ?? []), b]);
  }
  const served = new Set<string>();
  await Promise.all(
    [...groups.values()].slice(0, PROBE_CAP).map(async (group) => {
      const b = group[0]!;
      try {
        const res = await fetchImpl(b.url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
        await res.body?.cancel().catch(() => {});
        if (servedFine(b.code, res)) for (const m of group) served.add(key(m));
      } catch {
        // not shown to be fine: the errors stay findings
      }
    }),
  );
  return served;
}

function groupKey(b: BlockedResponse): string {
  try {
    const u = new URL(b.url);
    return `${b.code} ${u.origin}${u.pathname}`;
  } catch {
    return key(b);
  }
}

/** `report` with the errors of `served` responses relabelled, and its clusters rebuilt. Pure. */
export function markServed<R extends Pick<CrawlReport, "pages" | "errorClusters">>(report: R, served: ReadonlySet<string>): R {
  if (served.size === 0) return report;
  let changed = false;
  const pages = report.pages.map((p) => {
    // Codes whose every refusal on this page was served: their echoes go too.
    const codes = new Map<string, boolean>();
    for (const e of p.errors) {
      const b = blockedResponse(e);
      if (b) codes.set(b.code, (codes.get(b.code) ?? true) && served.has(key(b)));
    }
    const relabel = (e: PageError): boolean => {
      const b = blockedResponse(e);
      if (b) return served.has(key(b));
      const echo = e.type === "console" ? BLOCKED_ECHO.exec(e.message) : null;
      return echo !== null && codes.get(echo[1]!) === true;
    };
    if (!p.errors.some(relabel)) return p;
    changed = true;
    return { ...p, errors: p.errors.map((e) => (relabel(e) ? { ...e, message: `${e.message} ${SERVED_NOTE}` } : e)) };
  });
  if (!changed) return report;
  return { ...report, pages, errorClusters: clusterErrors(pages.flatMap((p) => p.errors)) };
}

function blockedResponse(e: Pick<PageError, "type" | "message">): BlockedResponse | undefined {
  const m = e.type === "network" ? BLOCKED_ERROR.exec(e.message) : null;
  return m ? { url: m[1]!, code: m[2] as BlockedCode } : undefined;
}

/** How `probeServed` names a refused response. */
export function key(b: BlockedResponse): string {
  return `${b.code} ${b.url}`;
}
