/**
 * `net::ERR_BLOCKED_BY_ORB` that the scan caused, told apart from the ones
 * the site did.
 *
 * Opaque Response Blocking stops a cross-origin `no-cors` response (an
 * `<img>` of another host) that does not look like the image or media it was
 * requested as, so it is often the site's bug: webscraper.io's blog image
 * answered 403 with an XML error body. But Chromium also blocks, now and then,
 * a file that is fine while the page's requests are intercepted, and the
 * crawler intercepts every request (fault injection, traceparent, the
 * external-navigation guard). jquery.com's team page lost gravatar avatars
 * that way: 200 image/jpeg when fetched, blocked by ORB in the scan, and
 * blocked in some loads (not others) of a plain Playwright page with
 * `page.route("**", r => r.fallback())`.
 *
 * So after the crawls, each blocked URL is fetched once outside the browser.
 * One that answers 2xx as an image, media or font is the scan's doing: its
 * errors are relabelled so the analysis reports them as an environment note
 * rather than a finding. One that fails, or answers anything else, stays.
 */

import { clusterErrors } from "../clusters.js";
import type { CrawlReport } from "../types.js";

const ORB_ERROR = /^(\S+) - net::ERR_BLOCKED_BY_ORB$/;

/** Appended to a relabelled error; `ENVIRONMENT_CAUSES` matches it. */
export const ORB_SERVED_NOTE = "(served fine when fetched directly)";

/** How many distinct blocked URLs are fetched at most. */
export const ORB_PROBE_CAP = 20;

const SERVABLE = /^(?:image|video|audio|font)\//;

/** The distinct URLs that `net::ERR_BLOCKED_BY_ORB` stopped, in any of the reports. */
export function orbBlockedUrls(reports: readonly Pick<CrawlReport, "pages">[]): string[] {
  const urls = new Set<string>();
  for (const r of reports) {
    for (const p of r.pages) {
      for (const e of p.errors) {
        const m = e.type === "network" ? ORB_ERROR.exec(e.message) : null;
        if (m) urls.add(m[1]!);
      }
    }
  }
  return [...urls];
}

/**
 * The URLs among `urls` that answer 2xx with an image, media or font type when
 * fetched directly. A network error, a timeout or any other answer leaves a
 * URL out, so its errors stay findings.
 */
export async function probeServedUrls(
  urls: readonly string[],
  { fetchImpl = fetch, timeoutMs = 10_000 }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<Set<string>> {
  const served = new Set<string>();
  await Promise.all(
    urls.slice(0, ORB_PROBE_CAP).map(async (url) => {
      try {
        const res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
        const type = res.headers.get("content-type") ?? "";
        await res.body?.cancel().catch(() => {});
        if (res.ok && SERVABLE.test(type)) served.add(url);
      } catch {
        // not shown to be fine: the error stays a finding
      }
    }),
  );
  return served;
}

/** `report` with the ORB errors of `served` URLs relabelled, and its clusters rebuilt. Pure. */
export function markServedOrb<R extends Pick<CrawlReport, "pages" | "errorClusters">>(report: R, served: ReadonlySet<string>): R {
  if (served.size === 0) return report;
  let changed = false;
  const pages = report.pages.map((p) => {
    if (!p.errors.some((e) => isServedOrb(e, served))) return p;
    changed = true;
    return {
      ...p,
      errors: p.errors.map((e) => (isServedOrb(e, served) ? { ...e, message: `${e.message} ${ORB_SERVED_NOTE}` } : e)),
    };
  });
  if (!changed) return report;
  return { ...report, pages, errorClusters: clusterErrors(pages.flatMap((p) => p.errors)) };
}

function isServedOrb(e: { type: string; message: string }, served: ReadonlySet<string>): boolean {
  const m = e.type === "network" ? ORB_ERROR.exec(e.message) : null;
  return m !== null && served.has(m[1]!);
}
