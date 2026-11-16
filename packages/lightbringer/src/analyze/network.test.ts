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
  it("counts a failed / aborted request at the time it failed, and lists it as failed with that duration", () => {
    const aborted: NetReq = { ...req(1003, undefined), failedEpochMs: 1150 };
    const net = buildSpanNetwork(click, [req(1002, 1040), aborted], "example.com");
    expect(net.settledMs).toBe(150);
    expect(net).not.toHaveProperty("settledUnfinished");
    const entry = net.requests.find((r) => r.failed);
    expect(entry).toMatchObject({ durationMs: 147, failed: true });
    expect(entry).not.toHaveProperty("unfinished");
  });
  it("keeps a request that failed late in the capped slowest-first list", () => {
    const span = { startEpochMs: 0, endEpochMs: 10_000 };
    // A request held open until a timeout failed it, among 20 finished ones.
    const finished = Array.from({ length: 20 }, (_, i) => req(0, 100 + i, `https://example.com/s${i}`));
    const hung: NetReq = { ...req(10, undefined, "https://example.com/api/hung"), failedEpochMs: 8010 };
    const net = buildSpanNetwork(span, [...finished, hung], "example.com");
    expect(net.requests).toHaveLength(20);
    expect(net.requests[0]).toMatchObject({ url: "https://example.com/api/hung", durationMs: 8000, failed: true });
  });
});

// A page that polls an endpoint keeps a request in every step: each span
// counted the polls as its own requests and, on a load, each poll as its own
// waterfall wave. `backgroundRequests` / `foregroundWaves` set them apart.
describe("buildSpanNetwork: background polling", () => {
  const O = "http://127.0.0.1";
  const req = (url: string, start: number, ms = 2): NetReq => ({
    url,
    type: "Fetch",
    startMono: 0,
    startEpochMs: start,
    endEpochMs: start + ms,
    encoded: 100,
  });
  // One request every `every` ms on [from, to).
  const poll = (url: (i: number) => string, from: number, to: number, every: number): NetReq[] =>
    Array.from({ length: Math.ceil((to - from) / every) }, (_, i) => req(url(i), from + i * every));

  it("counts the requests of a poll that ran before the span as background", () => {
    const reqs = poll(() => `${O}/api/status`, 0, 12_000, 100);
    const net = buildSpanNetwork({ startEpochMs: 10_000, endEpochMs: 12_000 }, reqs, "127.0.0.1");
    expect(net.requestCount).toBe(20);
    expect(net.backgroundRequests).toBe(20);
    expect(net.requests.every((r) => r.polled)).toBe(true);
  });

  it("drops a cache-busting query from the endpoint", () => {
    const reqs = poll((i) => `${O}/api/tick?${i}`, 0, 12_000, 50);
    const net = buildSpanNetwork({ startEpochMs: 10_000, endEpochMs: 12_000 }, reqs, "127.0.0.1");
    expect(net.backgroundRequests).toBe(40);
  });

  it("keeps a step's own burst on top of the poll as its own", () => {
    const reqs = [
      ...poll(() => `${O}/api/status`, 0, 12_000, 100),
      ...Array.from({ length: 40 }, (_, i) => req(`${O}/api/chat?q=${i}`, 10_050 + i)),
      // A burst to the polled endpoint itself: only the poll's rate is background.
      ...Array.from({ length: 30 }, () => req(`${O}/api/status`, 10_500)),
    ];
    const net = buildSpanNetwork({ startEpochMs: 10_000, endEpochMs: 12_000 }, reqs, "127.0.0.1");
    expect(net.requestCount).toBe(90);
    // rate 10/s × 2 s + 1 = 21 of the 50 /api/status requests.
    expect(net.backgroundRequests).toBe(21);
  });

  it("does not count a poll the span started, or a slow one", () => {
    const started = poll(() => `${O}/api/status`, 10_000, 14_000, 50);
    expect(
      buildSpanNetwork({ startEpochMs: 10_000, endEpochMs: 12_000 }, started, "127.0.0.1").backgroundRequests,
    ).toBeUndefined();
    // Every 2.5 s: two in the 5 s before the span, not a poll that keeps the page busy.
    const slow = poll(() => `${O}/api/status`, 0, 12_000, 2500);
    expect(
      buildSpanNetwork({ startEpochMs: 10_000, endEpochMs: 12_000 }, slow, "127.0.0.1").backgroundRequests,
    ).toBeUndefined();
  });

  it("leaves a poll that runs on after the span out of foregroundWaves", () => {
    const load = { startEpochMs: 0, endEpochMs: 5000 };
    const chain = ["a", "b", "c", "d", "e", "f"].map((p, i) => req(`${O}/api/chain/${p}`, 20 + i * 50, 45));
    const reqs = [req(`${O}/`, 0, 15), ...chain, ...poll(() => `${O}/api/status`, 100, 9000, 100)];
    const net = buildSpanNetwork(load, reqs, "127.0.0.1");
    expect(net.waves).toBeGreaterThan(40);
    expect(net.foregroundWaves).toBe(7);
    // Nothing polled before the load: none of its requests is background.
    expect(net.backgroundRequests).toBeUndefined();
    // A click navigated right after the load: the poll in the load is still one.
    expect(buildSpanNetwork(load, reqs, "127.0.0.1", [0, 5050]).foregroundWaves).toBe(7);
    // Back-to-back long-polls, each with a new cursor: one wave each, still a poll.
    const lp = [req(`${O}/`, 0, 15), ...[0, 1, 2, 3].map((i) => req(`${O}/api/lp?c=${i}`, 20 + i * 1201, 1200))];
    expect(buildSpanNetwork(load, lp, "127.0.0.1", [0]).waves).toBe(5);
    expect(buildSpanNetwork(load, lp, "127.0.0.1", [0]).foregroundWaves).toBe(1);
    // A chain of pages of one endpoint, each fetched as the last one answers: all its waves stay.
    const pages = [1, 2, 3, 4, 5, 6].map((n) => req(`${O}/api/items?page=${n}`, n * 50, 48));
    const paged = buildSpanNetwork(load, [req(`${O}/`, 0, 15), ...pages], "127.0.0.1");
    expect(paged.waves).toBe(7);
    expect(paged.foregroundWaves).toBeUndefined();
    expect(paged.requests.some((r) => r.polled)).toBe(false);
    // Scripts of one path queued behind each other are not a poll, gaps or not.
    const scripts = [1, 2, 3, 4, 5].map((n) => ({ ...req(`${O}/embed/player.js?v=${n}`, n * 100, 40), type: "Script" }));
    const queued = buildSpanNetwork(load, [req(`${O}/`, 0, 15), ...scripts], "127.0.0.1");
    expect(queued.waves).toBe(6);
    expect(queued.foregroundWaves).toBeUndefined();
  });
});

// A poll repeats within one step; a fetch that every step fires again, or a
// burst fired before the step, only looks like one when the steps are not
// told apart. Pages with no timer must keep their findings.
describe("buildSpanNetwork: a page that does not poll", () => {
  const O = "http://127.0.0.1";
  const req = (url: string, start: number, ms = 2): NetReq => ({
    url, type: "Fetch", startMono: 0, startEpochMs: start, endEpochMs: start + ms, encoded: 100,
  });
  const burst = (url: (i: number) => string, at: number, n: number): NetReq[] =>
    Array.from({ length: n }, (_, i) => req(url(i), at, 20));
  // A load at 0, then a click every 300 ms, each 200 ms long.
  const load = { startEpochMs: 0, endEpochMs: 400 };
  const stepStarts = [0, 700, 1000, 1300, 1600];

  it("does not read a fetch that each step fires again as a poll", () => {
    // Each step runs the same 6-endpoint chain, and fetches /api/user twice at once.
    const step = (t: number) => [
      ...["a", "b", "c", "d", "e", "f"].map((p, i) => req(`${O}/api/chain/${p}`, t + 10 + i * 50, 45)),
      req(`${O}/api/user`, t + 10, 20),
      req(`${O}/api/user`, t + 10, 20),
    ];
    const reqs = [req(`${O}/`, 0, 5), ...stepStarts.flatMap(step)];
    const net = buildSpanNetwork(load, reqs, "127.0.0.1", [0], stepStarts);
    expect(net.waves).toBe(7);
    expect(net.foregroundWaves).toBeUndefined();
    expect(net.requests.some((r) => r.polled)).toBe(false);
    // Without the step starts, the steps' refetches are one stretch: a poll.
    expect(buildSpanNetwork(load, reqs, "127.0.0.1", [0]).foregroundWaves).toBe(1);
  });

  it("does not count a burst before the span to the same endpoint as background", () => {
    // The same 40 queries, at a load or an earlier click, then in the span.
    const same = [...burst((i) => `${O}/api/chat?q=${i}`, 8000, 40), ...burst((i) => `${O}/api/chat?q=${i}`, 10_000, 40)];
    const span = { startEpochMs: 10_000, endEpochMs: 12_000 };
    const net = buildSpanNetwork(span, same, "127.0.0.1", [0], [0, 8000, 10_000]);
    expect(net.requestCount).toBe(40);
    expect(net.backgroundRequests).toBeUndefined();
    // Even with no step starts but the span's own (a single-endpoint API: GraphQL).
    const gql = [...burst(() => `${O}/graphql`, 200, 10), ...burst(() => `${O}/graphql`, 3000, 40)];
    expect(buildSpanNetwork({ startEpochMs: 3000, endEpochMs: 5000 }, gql, "127.0.0.1", [0]).backgroundRequests).toBeUndefined();
    // Two clicks 2.1 s apart, each firing 20 events at a collector.
    const collect = [...burst((i) => `${O}/api/collect?i=${i}`, 0, 20), ...burst((i) => `${O}/api/collect?i=${i}`, 2100, 20)];
    expect(buildSpanNetwork({ startEpochMs: 2100, endEpochMs: 4100 }, collect, "127.0.0.1").backgroundRequests).toBeUndefined();
  });

  it("still finds a poll with the step starts given, at its rate only", () => {
    const span = { startEpochMs: 10_000, endEpochMs: 12_000 };
    const steps = [0, 4000, 6000, 8000, 10_000];
    const poll = Array.from({ length: 120 }, (_, i) => req(`${O}/graphql`, i * 100));
    const pollNet = buildSpanNetwork(span, poll, "127.0.0.1", [0], steps);
    expect(pollNet.backgroundRequests).toBe(20);
    expect(pollNet.requests.every((r) => r.polled)).toBe(true);
    // A burst before the span to the polled endpoint does not raise the poll's rate:
    // (50 + 1) / 5 s × 2 s + 1 = 22 of the span's 50 (the next poll repeats the
    // burst's last request), not (50 + 30) / 5 s × 2 s + 1 = 33.
    const reqs = [...poll, ...burst(() => `${O}/graphql`, 7000, 30), ...burst(() => `${O}/graphql`, 10_500, 30)];
    expect(buildSpanNetwork(span, reqs, "127.0.0.1", [0], steps).backgroundRequests).toBe(22);
  });
});

describe("buildSpanNetwork: polling stops at a navigation", () => {
  const O = "http://127.0.0.1";
  const req = (url: string, start: number, ms = 2): NetReq => ({
    url, type: "Fetch", startMono: 0, startEpochMs: start, endEpochMs: start + ms, encoded: 100,
  });
  it("does not count the next pages' loads as a poll of this load", () => {
    // Three quick navigations after the load, each running the same chain once.
    const chain = (t: number) => ["a", "b", "c"].map((p, i) => req(`${O}/api/chain/${p}`, t + 10 + i * 50, 45));
    const reqs = [0, 400, 800, 1200].flatMap((t) => [req(`${O}/`, t, 5), ...chain(t)]);
    const load = { startEpochMs: 0, endEpochMs: 300 };
    expect(buildSpanNetwork(load, reqs, "127.0.0.1").foregroundWaves).toBeDefined();
    const net = buildSpanNetwork(load, reqs, "127.0.0.1", [1, 401, 801, 1201]);
    expect(net.waves).toBe(4);
    expect(net.foregroundWaves).toBeUndefined();
  });
  it("does not count the previous page's poll as this document's", () => {
    const reqs = Array.from({ length: 50 }, (_, i) => req(`${O}/api/status`, i * 100));
    // A document started at 4000 (a click navigated); the span at 4100 sees one poll before it.
    const net = buildSpanNetwork({ startEpochMs: 4100, endEpochMs: 4900 }, reqs, "127.0.0.1", [0, 4000]);
    expect(net.backgroundRequests).toBeUndefined();
    // A span that loaded the document has no before.
    expect(buildSpanNetwork({ startEpochMs: 3950, endEpochMs: 4900 }, reqs, "127.0.0.1", [0, 4000]).backgroundRequests).toBeUndefined();
    expect(buildSpanNetwork({ startEpochMs: 3950, endEpochMs: 4900 }, reqs, "127.0.0.1", [0]).backgroundRequests).toBe(10);
  });
});
