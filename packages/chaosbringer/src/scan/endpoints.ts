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

/**
 * Same-origin paths a CDN or host injects, not the app's API: Cloudflare's
 * RUM beacon and challenge scripts (`/cdn-cgi/`), Vercel's analytics
 * (`/_vercel/`), and `/.well-known/`. Failing them tests the host's script.
 */
const INFRASTRUCTURE_PATH = /^https?:\/\/[^/]+\/(?:cdn-cgi|_vercel|\.well-known)\//;

/**
 * Static files a page fetches with fetch() (a framework's CSS chunks on a
 * client-side navigation, a WebAssembly runtime, a 3D model): failing them
 * is a CDN outage, not the app's API failing, and the chaos crawls are
 * about the API.
 */
const STATIC_FILE = /\.(?:css|m?js|cjs|map|wasm|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|mp3|ogg|glb|gltf|bin)$/i;

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
  // The site's own pages, as endpoints would be labelled. A framework that
  // fetches a route's data from the route's own URL (Next.js App Router's
  // `/docs?_rsc=…`) makes the page an "endpoint"; failing it fails the
  // document itself, and the page "breaks" because the scan broke it.
  const pages = new Set(report.pages.map((p) => endpointLabel(p.url)).filter((l): l is string => l !== null));
  const byLabel = new Map<string, ScanEndpoint>();
  for (const r of requests) {
    if (!API_TYPES.has(r.type) || r.thirdParty || INFRASTRUCTURE_PATH.test(r.url)) continue;
    let u: URL;
    try {
      u = new URL(r.url);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (STATIC_FILE.test(u.pathname)) continue;
    const segments = u.pathname.split("/").map((seg) => (isIdLike(seg) ? ":id" : seg));
    const label = `${u.origin}${segments.join("/")}`;
    if (pages.has(label) || pages.has(label.replace(/\/$/, "")) || pages.has(`${label}/`)) continue;
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
