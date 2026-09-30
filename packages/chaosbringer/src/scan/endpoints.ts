/**
 * The API endpoints a scan's chaos crawl injects faults on. An unknown site
 * has no list of its API, so it is read off the clean crawl: every fetch /
 * XHR request the measured spans saw. Pure over the report and its sidecars'
 * spans, so the derivation is unit-testable.
 */

import { reportSpans } from "../perf-summary.js";
import type { CrawlReport } from "../types.js";

/** CDP resource types that are the app's own data requests. */
const API_TYPES = new Set(["Fetch", "XHR"]);

/** How many endpoints the chaos crawl targets at most. */
export const SCAN_ENDPOINT_CAP = 40;

export interface ScanEndpoint {
  /** `origin + path`, with id-like segments shown as `:id`. */
  label: string;
  /** Anchored regex source matching the endpoint with any query string. */
  pattern: string;
  /** Times the clean crawl requested it. */
  count: number;
}

type RequestLike = { url: string; type: string; thirdParty?: boolean };

/**
 * Endpoints the app's own code requested, most requested first. Third-party
 * requests (analytics, embeds) are left out: a failing tag is a different
 * question from whether the app handles its own API failing.
 * Hand it a report with the sidecars' request lists put back
 * (`withSidecarRequests`): the report alone keeps the five slowest per span.
 */
export function deriveScanEndpoints(report: Pick<CrawlReport, "pages" | "actions">): ScanEndpoint[] {
  const requests: RequestLike[] = [];
  for (const s of reportSpans(report)) requests.push(...s.network.requests);
  const byLabel = new Map<string, ScanEndpoint>();
  for (const r of requests) {
    if (!API_TYPES.has(r.type) || r.thirdParty) continue;
    let u: URL;
    try {
      u = new URL(r.url);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    const segments = u.pathname.split("/").map((seg) => (isIdLike(seg) ? ":id" : seg));
    const label = `${u.origin}${segments.join("/")}`;
    const prev = byLabel.get(label);
    if (prev) {
      prev.count++;
      continue;
    }
    const path = segments.map((seg) => (seg === ":id" ? "[^/]+" : escapeRegex(seg))).join("/");
    byLabel.set(label, { label, pattern: `^${escapeRegex(u.origin)}${path}(?:[?#].*)?$`, count: 1 });
  }
  return [...byLabel.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, SCAN_ENDPOINT_CAP);
}

/** One regex source matching any of the endpoints, or `null` when there are none. */
export function endpointsPattern(endpoints: readonly ScanEndpoint[]): string | null {
  if (endpoints.length === 0) return null;
  return endpoints.map((e) => `(?:${e.pattern})`).join("|");
}

/** `origin + path` of a URL with id-like path segments as `:id`, or `null` for a non-http(s) URL. */
export function endpointLabel(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return `${u.origin}${u.pathname
    .split("/")
    .map((seg) => (isIdLike(seg) ? ":id" : seg))
    .join("/")}`;
}

function isIdLike(seg: string): boolean {
  return (
    /^\d+$/.test(seg) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) ||
    /^[0-9a-f]{16,}$/i.test(seg)
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
