import { describe, expect, it } from "vitest";
import { buildSpanNetwork, countWaves, isThirdParty, registrableDomain, unionLength, type NetReq } from "./network";

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

// B2 (2026-09-24 evaluation): a request started by one span and still running
// through the next spans used to be counted, with its bytes, in every span it
// overlapped, so a click that fired nothing read `requestCount: 2`.
describe("buildSpanNetwork attributes a request to the span it started in", () => {
  const first = { startEpochMs: 1000, endEpochMs: 1050 };
  const second = { startEpochMs: 1150, endEpochMs: 1200 };
  const third = { startEpochMs: 1300, endEpochMs: 1380 };
  // fired 30 ms into `first`, answered 300 ms later: in flight through `second`
  // and into `third`.
  const delayed: NetReq = {
    url: "https://example.com/api/item/6", type: "Fetch", startMono: 0,
    startEpochMs: 1030, endEpochMs: 1335, encoded: 2048,
  };
  it("counts it, its bytes and its full duration on the span that fired it", () => {
    const net = buildSpanNetwork(first, [delayed], "example.com");
    expect(net.requestCount).toBe(1);
    expect(net.encodedKB).toBe(2);
    expect(net.requests).toEqual([
      expect.objectContaining({ startOffsetMs: 30, durationMs: 305 }),
    ]);
    // busy time stays what the span itself saw of the network
    expect(net.busyMs).toBe(20);
  });
  it("does not count it on later spans it only overlaps, which still see the network busy", () => {
    for (const span of [second, third]) {
      const net = buildSpanNetwork(span, [delayed], "example.com");
      expect(net.requestCount).toBe(0);
      expect(net.encodedKB).toBe(0);
      expect(net.requests).toEqual([]);
      expect(net.thirdParty.requestCount).toBe(0);
      expect(net.byInitiator).toEqual([]);
      expect(net.waves).toBe(0);
    }
    expect(buildSpanNetwork(second, [delayed], "example.com").busyMs).toBe(50);
    expect(buildSpanNetwork(third, [delayed], "example.com").busyMs).toBe(35);
  });
  it("flags a request with no response yet instead of passing 0 off as its duration", () => {
    const pending: NetReq = { ...delayed, endEpochMs: undefined, encoded: undefined };
    const net = buildSpanNetwork(first, [pending], "example.com");
    expect(net.requestCount).toBe(1);
    expect(net.requests[0]).toMatchObject({ durationMs: 0, unfinished: true });
    expect(buildSpanNetwork(first, [delayed], "example.com").requests[0]).not.toHaveProperty("unfinished");
  });
});

// B2 follow-up (2026-09-24 evaluation): under the networkidle settle a click
// that fires a fetch closes a few ms after the fetch starts, so its
// durationMs never includes a delay fault on that fetch. `settledMs` is when
// the span's own requests were done.
describe("buildSpanNetwork settledMs", () => {
  const click = { startEpochMs: 1000, endEpochMs: 1005 };
  const req = (startEpochMs: number, endEpochMs: number | undefined, url = "https://example.com/api/x"): NetReq => ({
    url, type: "Fetch", startMono: 0, startEpochMs, endEpochMs, encoded: 100,
  });
  it("is the end of the last request the span started, past the span's end", () => {
    const net = buildSpanNetwork(click, [req(1002, 1302), req(1003, 1040)], "example.com");
    expect(net.settledMs).toBe(302);
    expect(net).not.toHaveProperty("settledUnfinished");
  });
  it("is absent when the span started no request, even while an earlier one runs", () => {
    const net = buildSpanNetwork(click, [req(900, 1300)], "example.com");
    expect(net.busyMs).toBe(5);
    expect(net).not.toHaveProperty("settledMs");
    expect(net).not.toHaveProperty("settledUnfinished");
  });
  it("is computed over every own request, before the detail list is capped", () => {
    const span = { startEpochMs: 0, endEpochMs: 1000 };
    // 20 slow requests fill the slowest-first list; a short late one ends last.
    const slow = Array.from({ length: 20 }, (_, i) => req(0, 100 + i, `https://example.com/s${i}`));
    const net = buildSpanNetwork(span, [...slow, req(500, 510, "https://example.com/late")], "example.com");
    expect(net.requests).toHaveLength(20);
    expect(net.requests.some((r) => r.url.endsWith("/late"))).toBe(false);
    expect(net.settledMs).toBe(510);
  });
  it("leaves an unfinished request out rather than inventing its end, and flags it", () => {
    const partial = buildSpanNetwork(click, [req(1002, 1302), req(1003, undefined)], "example.com");
    expect(partial.settledMs).toBe(302);
    expect(partial.settledUnfinished).toBe(true);
    const none = buildSpanNetwork(click, [req(1003, undefined)], "example.com");
    expect(none).not.toHaveProperty("settledMs");
    expect(none.settledUnfinished).toBe(true);
  });
  it("counts a failed / aborted request at the time it failed, keeping its detail entry unfinished", () => {
    const aborted: NetReq = { ...req(1003, undefined), failedEpochMs: 1150 };
    const net = buildSpanNetwork(click, [req(1002, 1040), aborted], "example.com");
    expect(net.settledMs).toBe(150);
    expect(net).not.toHaveProperty("settledUnfinished");
    expect(net.requests.find((r) => r.durationMs === 0)).toMatchObject({ unfinished: true });
  });
});
