// Network analysis: CDP Network.* records → per-span / scenario network breakdown
// (bytes, busy time, waterfall depth, third-party slice, request initiators).
// Pure: consumes plain NetReq records produced by the capture layer.
import { round, type EpochWindow } from "./util";

/**
 * What triggered a request (CDP `Network.requestWillBeSent.initiator`). The
 * network-side analogue of the CPU drilldown: when a span's waterfall is deep,
 * this points at the code (or the parser) that issued the requests.
 */
export interface Initiator {
  /** script | parser | preload | preflight | other */
  type: string;
  /** best-effort triggering site: "functionName  url:line" (script) or "url:line" (parser) */
  frame?: string;
}

/** Requests grouped by what issued them (heaviest first, by request count). */
export interface InitiatorStat {
  frame: string;
  type: string;
  requestCount: number;
  encodedKB: number;
}

/**
 * Cost a span incurs from third-party origins (analytics, tag managers, ad
 * tech, embedded widgets) — anything served from a registrable domain other
 * than the page's own. This is the "weight emitted by non-application scripts":
 * bytes the app didn't ship and network time it didn't ask for. CPU spent by
 * third-party scripts is attributed separately by the drilldown (PERF_TRACE),
 * which classifies CPU-profiler frames by their script URL host.
 */
export interface ThirdPartyBreakdown {
  requestCount: number;
  encodedKB: number;
  /** wall time third-party requests kept the network busy (union of intervals, ms) */
  busyMs: number;
  /** per registrable-domain breakdown, heaviest first (by bytes) */
  byDomain: Array<{
    domain: string;
    requestCount: number;
    encodedKB: number;
    busyMs: number;
  }>;
}

/** Network breakdown of a span (network bottleneck analysis). */
export interface SpanNetwork {
  requestCount: number;
  encodedKB: number;
  /** Wall time the network was busy during the span (union of request intervals, ms). */
  busyMs: number;
  /** Waterfall waves = approximate depth of serial dependency. 1 = one parallel wave. */
  waves: number;
  /** subset of this span's network attributable to third-party origins */
  thirdParty: ThirdPartyBreakdown;
  /** requests grouped by what issued them (top issuers first); over ALL requests */
  byInitiator: InitiatorStat[];
  requests: Array<{
    url: string;
    type: string;
    /** start offset relative to the span start (ms) */
    startOffsetMs: number;
    durationMs: number;
    kb: number;
    /** true if served from a registrable domain other than the page's */
    thirdParty: boolean;
    /** what triggered the request (code / parser), best-effort */
    initiator?: Initiator;
  }>;
}

export interface NetworkReport {
  totalRequests: number;
  totalEncodedKB: number;
  byType: Record<string, { count: number; encodedKB: number }>;
  slowest: Array<{ url: string; type: string; durationMs: number; kb: number }>;
  /** scenario-wide third-party total (bytes/requests the app didn't ship) */
  thirdParty: ThirdPartyBreakdown;
  /** scenario-wide request issuers (which code / parser issued the most requests) */
  byInitiator: InitiatorStat[];
  /** requests served from cache (disk / memory / prefetch / SW) — no network fetch */
  fromCacheCount: number;
}

/**
 * One captured network request, in epoch ms. Produced by the CDP capture layer
 * (collector.startNetworkCapture) and consumed by the builders below; the record
 * contract lives with the analysis that reads it.
 */
export interface NetReq {
  url: string;
  type: string;
  startMono: number;
  startEpochMs: number;
  endEpochMs?: number;
  encoded?: number;
  initiator?: Initiator;
  /** served from disk / memory / prefetch / service-worker cache (no network fetch) */
  fromCache?: boolean;
}

/** CDP initiator shape (only the fields we read). */
export interface CdpInitiator {
  type?: string;
  url?: string;
  lineNumber?: number;
  stack?: {
    callFrames?: Array<{
      functionName?: string;
      url?: string;
      lineNumber?: number;
    }>;
  };
}

/** Max per-request detail entries kept per span (slowest-first); counts/bytes are full. */
const REQUESTS_PER_SPAN_LIMIT = 20;

// First-party vs third-party classification by registrable domain.
// Not a full Public Suffix List — a compact set of common multi-label suffixes
// keeps "third party" honest on typical hosts without bundling the PSL. A
// request is first-party when its registrable domain equals the page's.
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "gov.uk", "ac.uk", "org.uk", "co.jp", "ne.jp", "or.jp", "go.jp",
  "ac.jp", "co.kr", "co.in", "co.nz", "co.za", "com.au", "com.br", "com.cn",
  "com.tw", "com.hk", "com.sg", "com.mx",
]);

/** Trim the origin off a URL for compact display (mirrors the drilldown). */
export function shortenUrl(url: string): string {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    return `${url.slice(0, comma > 0 ? Math.min(comma, 40) : 40)}…`;
  }
  return url.replace(/^https?:\/\/[^/]+/, "").slice(0, 60) || url.slice(0, 60);
}

/** Reduce a CDP initiator to a type + a single best-effort triggering frame. */
export function summarizeInitiator(
  init: CdpInitiator | undefined,
): Initiator | undefined {
  if (!init) return undefined;
  const type = init.type ?? "other";
  const frames = init.stack?.callFrames ?? [];
  // the topmost frame with a script URL is the code that issued the request
  const top = frames.find((f) => f.url) ?? frames[0];
  if (top) {
    const fn = top.functionName || "(anonymous)";
    const loc = top.url ? `${shortenUrl(top.url)}:${(top.lineNumber ?? 0) + 1}` : "";
    return { type, frame: `${fn}  ${loc}`.trim() };
  }
  // parser-inserted (e.g. <img>/<script src>): initiator.url is the referencing doc
  if (init.url) {
    const loc = init.lineNumber != null ? `:${init.lineNumber + 1}` : "";
    return { type, frame: `${shortenUrl(init.url)}${loc}` };
  }
  return { type };
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null; // data:, blob:, about: — treated as first-party (inline)
  }
}

/** Registrable domain (eTLD+1), best-effort. IPs and bare hosts pass through. */
export function registrableDomain(host: string): string {
  if (host.includes(":")) return host; // IPv6
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host; // IPv4
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(last2) ? parts.slice(-3).join(".") : last2;
}

export function isThirdParty(reqUrl: string, firstPartyDomain: string): boolean {
  const h = hostOf(reqUrl);
  if (!h || !firstPartyDomain) return false;
  return registrableDomain(h) !== firstPartyDomain;
}

/** Length of the union of intervals. Used for network busy time. */
export function unionLength(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s > curEnd) {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  total += curEnd - curStart;
  return total;
}

/**
 * Number of waterfall waves = approximate serial dependency depth. Scans request
 * intervals in start order; a request that starts after the running wave's max
 * end time begins a new wave. 1 = fully parallel, higher = deeper fetch chains.
 */
export function countWaves(intervals: Array<[number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let waves = 1;
  let waveEnd = sorted[0][1];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s > waveEnd) {
      waves += 1;
      waveEnd = e;
    } else {
      waveEnd = Math.max(waveEnd, e);
    }
  }
  return waves;
}

/** Aggregate the third-party slice of a set of network records. */
export function buildThirdParty(
  records: Array<{ url: string; encodedKB: number; interval?: [number, number] }>,
  firstPartyDomain: string,
): ThirdPartyBreakdown {
  const byDomain = new Map<
    string,
    { requestCount: number; encodedKB: number; intervals: Array<[number, number]> }
  >();
  const allIntervals: Array<[number, number]> = [];
  let requestCount = 0;
  let encodedKB = 0;
  for (const r of records) {
    if (!isThirdParty(r.url, firstPartyDomain)) continue;
    const host = hostOf(r.url);
    if (!host) continue;
    const domain = registrableDomain(host);
    const bucket =
      byDomain.get(domain) ??
      byDomain.set(domain, { requestCount: 0, encodedKB: 0, intervals: [] }).get(domain)!;
    bucket.requestCount += 1;
    bucket.encodedKB += r.encodedKB;
    requestCount += 1;
    encodedKB += r.encodedKB;
    if (r.interval) {
      bucket.intervals.push(r.interval);
      allIntervals.push(r.interval);
    }
  }
  return {
    requestCount,
    encodedKB: round(encodedKB),
    busyMs: round(unionLength(allIntervals)),
    byDomain: [...byDomain.entries()]
      .map(([domain, v]) => ({
        domain,
        requestCount: v.requestCount,
        encodedKB: round(v.encodedKB),
        busyMs: round(unionLength(v.intervals)),
      }))
      .sort((a, b) => b.encodedKB - a.encodedKB),
  };
}

/** Aggregate requests by their initiator frame (top issuers first, by count). */
export function buildInitiators(
  records: Array<{ initiator?: Initiator; encodedKB: number }>,
): InitiatorStat[] {
  const by = new Map<string, InitiatorStat>();
  for (const r of records) {
    if (!r.initiator) continue;
    const frame = r.initiator.frame ?? `(${r.initiator.type})`;
    const bucket =
      by.get(frame) ??
      by.set(frame, { frame, type: r.initiator.type, requestCount: 0, encodedKB: 0 }).get(frame)!;
    bucket.requestCount += 1;
    bucket.encodedKB += r.encodedKB;
  }
  return [...by.values()]
    .map((s) => ({ ...s, encodedKB: round(s.encodedKB) }))
    .sort((a, b) => b.requestCount - a.requestCount || b.encodedKB - a.encodedKB)
    .slice(0, 8);
}

export function buildGlobalNetwork(
  reqs: NetReq[],
  firstPartyDomain: string,
): NetworkReport {
  const byType: NetworkReport["byType"] = {};
  let totalEncoded = 0;
  const finished: NetworkReport["slowest"] = [];
  const tpRecords: Array<{
    url: string;
    encodedKB: number;
    interval?: [number, number];
    initiator?: Initiator;
  }> = [];
  for (const r of reqs) {
    const encoded = r.encoded ?? 0;
    totalEncoded += encoded;
    const bucket = (byType[r.type] ??= { count: 0, encodedKB: 0 });
    bucket.count += 1;
    bucket.encodedKB += encoded / 1024;
    if (r.endEpochMs != null) {
      finished.push({
        url: r.url,
        type: r.type,
        durationMs: round(r.endEpochMs - r.startEpochMs),
        kb: round(encoded / 1024),
      });
    }
    tpRecords.push({
      url: r.url,
      encodedKB: encoded / 1024,
      interval:
        r.endEpochMs != null ? [r.startEpochMs, r.endEpochMs] : undefined,
      initiator: r.initiator,
    });
  }
  for (const b of Object.values(byType)) b.encodedKB = round(b.encodedKB);
  finished.sort((a, b) => b.durationMs - a.durationMs);
  return {
    totalRequests: reqs.length,
    totalEncodedKB: round(totalEncoded / 1024),
    byType,
    slowest: finished.slice(0, 8),
    thirdParty: buildThirdParty(tpRecords, firstPartyDomain),
    byInitiator: buildInitiators(tpRecords),
    fromCacheCount: reqs.filter((r) => r.fromCache).length,
  };
}

export function buildSpanNetwork(
  span: EpochWindow,
  reqs: NetReq[],
  firstPartyDomain: string,
): SpanNetwork {
  const intervals: Array<[number, number]> = [];
  const requests: SpanNetwork["requests"] = [];
  const tpRecords: Array<{
    url: string;
    encodedKB: number;
    interval?: [number, number];
    initiator?: Initiator;
  }> = [];
  let encoded = 0;
  for (const r of reqs) {
    const end = r.endEpochMs ?? r.startEpochMs;
    if (r.startEpochMs > span.endEpochMs || end < span.startEpochMs) continue;
    encoded += r.encoded ?? 0;
    const clipStart = Math.max(r.startEpochMs, span.startEpochMs);
    const clipEnd = Math.min(end, span.endEpochMs);
    const interval: [number, number] | undefined =
      clipEnd > clipStart ? [clipStart, clipEnd] : undefined;
    if (interval) intervals.push(interval);
    const tp = isThirdParty(r.url, firstPartyDomain);
    requests.push({
      url: r.url,
      type: r.type,
      startOffsetMs: round(r.startEpochMs - span.startEpochMs),
      durationMs: round(end - r.startEpochMs),
      kb: round((r.encoded ?? 0) / 1024),
      thirdParty: tp,
      initiator: r.initiator,
    });
    tpRecords.push({
      url: r.url,
      encodedKB: (r.encoded ?? 0) / 1024,
      interval,
      initiator: r.initiator,
    });
  }
  requests.sort((a, b) => b.durationMs - a.durationMs);
  // Cap the per-request detail list: a span on a request-heavy page can hold
  // hundreds of entries and bloat every report. Counts/bytes/busy/thirdParty
  // above are computed over all requests; only the (slowest-first) detail is cut.
  const requestCount = requests.length;
  return {
    requestCount,
    encodedKB: round(encoded / 1024),
    busyMs: round(unionLength(intervals)),
    waves: countWaves(intervals),
    thirdParty: buildThirdParty(tpRecords, firstPartyDomain),
    byInitiator: buildInitiators(tpRecords),
    requests: requests.slice(0, REQUESTS_PER_SPAN_LIMIT),
  };
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("registrableDomain", () => {
    it("collapses subdomains to eTLD+1", () => {
      expect(registrableDomain("a.b.example.com")).toBe("example.com");
    });
    it("keeps the third label for known multi-part suffixes", () => {
      expect(registrableDomain("foo.bar.co.jp")).toBe("bar.co.jp");
    });
    it("passes IPv4 through untouched", () => {
      expect(registrableDomain("127.0.0.1")).toBe("127.0.0.1");
    });
  });

  describe("isThirdParty", () => {
    it("treats a different registrable domain as third-party", () => {
      expect(isThirdParty("https://cdn.other.com/a.js", "example.com")).toBe(true);
    });
    it("treats a subdomain of the page domain as first-party", () => {
      expect(isThirdParty("https://api.example.com/x", "example.com")).toBe(false);
    });
    it("treats data: / inline as first-party", () => {
      expect(isThirdParty("data:text/js,1", "example.com")).toBe(false);
    });
  });

  describe("unionLength", () => {
    it("merges overlapping intervals", () => {
      expect(unionLength([[0, 10], [5, 15]])).toBe(15);
    });
    it("sums disjoint intervals", () => {
      expect(unionLength([[0, 10], [20, 25]])).toBe(15);
    });
  });

  describe("countWaves", () => {
    it("counts fully-parallel requests as one wave", () => {
      expect(countWaves([[0, 10], [1, 9], [2, 8]])).toBe(1);
    });
    it("counts a serial chain as N waves", () => {
      expect(countWaves([[0, 10], [11, 20], [21, 30]])).toBe(3);
    });
  });

  describe("buildSpanNetwork", () => {
    const span = { startEpochMs: 1000, endEpochMs: 2000 };
    it("splits first- vs third-party bytes and busy time", () => {
      const reqs: NetReq[] = [
        { url: "https://example.com/app.js", type: "Script", startMono: 0, startEpochMs: 1000, endEpochMs: 1500, encoded: 1024 },
        { url: "https://ads.other.com/t.js", type: "Script", startMono: 0, startEpochMs: 1200, endEpochMs: 1800, encoded: 2048 },
      ];
      const net = buildSpanNetwork(span, reqs, "example.com");
      expect(net.requestCount).toBe(2);
      expect(net.thirdParty.requestCount).toBe(1);
      expect(net.thirdParty.encodedKB).toBe(2);
      expect(net.thirdParty.byDomain[0]?.domain).toBe("other.com");
    });
    it("ignores requests outside the span window", () => {
      const reqs: NetReq[] = [
        { url: "https://example.com/late.js", type: "Script", startMono: 0, startEpochMs: 5000, endEpochMs: 6000, encoded: 1024 },
      ];
      expect(buildSpanNetwork(span, reqs, "example.com").requestCount).toBe(0);
    });
  });
}
