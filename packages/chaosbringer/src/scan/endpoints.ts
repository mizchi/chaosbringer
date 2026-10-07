/**
 * The API endpoints a scan's chaos crawl injects faults on. An unknown site
 * has no list of its API, so it is read off the clean crawl: every fetch /
 * XHR request the measured spans saw. Pure over the report and its sidecars'
 * spans, so the derivation is unit-testable.
 */

import { escapeRegExp, matchesAnyPattern } from "../filters.js";
import { isIdSegment } from "../perf-key.js";
import { reportSpans } from "../perf-summary.js";
import type { CrawlReport } from "../types.js";

/** CDP resource types that are the app's own data requests. */
export const API_TYPES: ReadonlySet<string> = new Set(["Fetch", "XHR"]);

/** A request the app's own code made for data: fetch / XHR, not to a third party. */
export function isOwnApiRequest(r: { type: string; thirdParty?: boolean }): boolean {
  return API_TYPES.has(r.type) && !r.thirdParty;
}

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
const SCAN_ENDPOINT_CAP = 40;

export interface ScanEndpoint {
  /** `origin + path`, with id-like segments shown as `:id`. */
  label: string;
  /** Anchored regex source matching the endpoint with any query string. */
  pattern: string;
  /** Times the clean crawl requested it. */
  count: number;
}

export type RequestLike = { url: string; type: string; thirdParty?: boolean };

/**
 * Endpoints the app's own code requested, most requested first. Third-party
 * requests (analytics, embeds) are left out: a failing tag is a different
 * question from whether the app handles its own API failing.
 * Hand it a report with the sidecars' request lists put back
 * (`withSidecarRequests`): the report alone keeps the five slowest per span.
 */
export function deriveScanEndpoints(
  report: Pick<CrawlReport, "pages" | "actions">,
  { exclude = [] }: { exclude?: readonly string[] } = {},
): ScanEndpoint[] {
  const requests: RequestLike[] = [];
  for (const s of reportSpans(report)) requests.push(...s.network.requests);
  return endpointsFromRequests(
    requests,
    report.pages.flatMap((p) => [p.url, ...(p.links ?? [])]),
    { exclude },
  );
}

/**
 * `deriveScanEndpoints` over a plain request list and the site's own page
 * URLs (the visited ones and the ones they link to), for a runner that has
 * no crawl report: `drive`'s chaos replay records requests itself.
 */
export function endpointsFromRequests(
  requests: readonly RequestLike[],
  pageUrls: readonly string[],
  { exclude = [] }: { exclude?: readonly string[] } = {},
): ScanEndpoint[] {
  // The site's own pages, as endpoints would be labelled: the ones crawled
  // and the ones they link to. A framework that fetches a route's data from
  // the route's own URL (Next.js App Router's `/docs?_rsc=…`) makes a page an
  // "endpoint": failing the crawled ones fails the document itself, and
  // failing the linked ones fails the router's prefetches of them (on
  // tailwindcss.com every endpoint was a prefetched docs page, and the
  // "retry storm" was the router prefetching more of them). Compared without
  // a trailing slash, so `/docs` and `/docs/` are one page.
  const pages = new Set<string>();
  for (const u of pageUrls) {
    const label = endpointLabel(u);
    if (label !== null) pages.add(withoutTrailingSlash(label));
  }
  const byLabel = new Map<string, ScanEndpoint>();
  for (const r of requests) {
    if (!isOwnApiRequest(r) || INFRASTRUCTURE_PATH.test(r.url)) continue;
    // URLs the crawl must not reach are not its to break either: a router
    // prefetching the target of a redirect (tailwindcss.com's /plus →
    // /plus/login) requests an excluded login page.
    if (matchesAnyPattern(r.url, exclude)) continue;
    const route = parseRoute(r.url);
    if (!route || STATIC_FILE.test(route.pathname)) continue;
    const label = `${route.origin}${route.segments.join("/")}`;
    if (pages.has(withoutTrailingSlash(label))) continue;
    const prev = byLabel.get(label);
    if (prev) {
      prev.count++;
      continue;
    }
    const path = route.segments.map((seg) => (seg === ":id" ? "[^/]+" : escapeRegExp(seg))).join("/");
    byLabel.set(label, { label, pattern: `^${escapeRegExp(route.origin)}${path}(?:[?#].*)?$`, count: 1 });
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
  const route = parseRoute(url);
  return route ? `${route.origin}${route.segments.join("/")}` : null;
}

/** An http(s) URL's origin and path, its id-like segments as `:id`; `null` for anything else. */
function parseRoute(url: string): { origin: string; pathname: string; segments: string[] } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return { origin: u.origin, pathname: u.pathname, segments: u.pathname.split("/").map((seg) => (isIdSegment(seg) ? ":id" : seg)) };
}

function withoutTrailingSlash(label: string): string {
  return label.endsWith("/") ? label.slice(0, -1) : label;
}
