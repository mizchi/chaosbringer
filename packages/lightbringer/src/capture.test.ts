import { describe, expect, it } from "vitest";
import { NetworkRecorder, PAGE_SCOPE } from "./capture";
import { buildSpanNetwork } from "./analyze/network";

// Network events of one page arrive from several CDP targets: the page's own
// session and each out-of-process iframe's (./targets). NetworkRecorder merges
// them into one request list, scoped per target.

const WALL0 = 1_700_000_000; // epoch s at monotonic 100 s
const sent = (
  requestId: string,
  url: string,
  atMs: number,
  type = "Script",
) => ({
  requestId,
  request: { url },
  type,
  timestamp: 100 + atMs / 1000,
  wallTime: WALL0 + atMs / 1000,
});
const finished = (requestId: string, atMs: number, bytes: number) => ({
  requestId,
  timestamp: 100 + atMs / 1000,
  encodedDataLength: bytes,
});
const at = (ms: number) => WALL0 * 1000 + ms;

describe("NetworkRecorder", () => {
  it("keeps the same requestId from two targets as two requests", () => {
    const r = new NetworkRecorder();
    r.handle(PAGE_SCOPE, "Network.requestWillBeSent", sent("1000.2", "http://a.test/app.js", 0));
    r.handle("CHILD", "Network.requestWillBeSent", sent("1000.2", "http://b.test/widget.js", 5));
    r.handle("CHILD", "Network.loadingFinished", finished("1000.2", 50, 4096));
    r.handle(PAGE_SCOPE, "Network.loadingFinished", finished("1000.2", 30, 1024));
    const reqs = r.requests();
    expect(reqs.map((q) => [q.url, q.encoded])).toEqual([
      ["http://a.test/app.js", 1024],
      ["http://b.test/widget.js", 4096],
    ]);
    expect(reqs[1]!.endEpochMs).toBeCloseTo(at(50), 3);
  });

  it("completes an OOPIF's document request from the child's target", () => {
    // The parent sends the navigation; the iframe's process receives the body.
    const r = new NetworkRecorder();
    const NAV = "5EAA5556E13D22A40F3C79CB0C86E2F3";
    r.handle(PAGE_SCOPE, "Network.requestWillBeSent", sent(NAV, "http://b.test/frame", 0, "Document"));
    r.handle(PAGE_SCOPE, "Network.responseReceived", { requestId: NAV, type: "Document" });
    r.handle("CHILD", "Network.loadingFinished", finished(NAV, 20, 300));
    r.handle("CHILD", "Network.requestWillBeSent", sent("1050.2", "http://b.test/a.js", 21));
    r.handle("CHILD", "Network.loadingFinished", finished("1050.2", 40, 100_000));
    const reqs = r.requests();
    expect(reqs).toHaveLength(2);
    expect(reqs[0]).toMatchObject({ url: "http://b.test/frame", encoded: 300, type: "Document" });
    expect(reqs[0]!.endEpochMs).toBeCloseTo(at(20), 3);
    expect(reqs[1]).toMatchObject({ url: "http://b.test/a.js", encoded: 100_000 });
  });

  it("does not complete another target's subresource with a colliding id", () => {
    const r = new NetworkRecorder();
    r.handle(PAGE_SCOPE, "Network.requestWillBeSent", sent("7.1", "http://a.test/x.js", 0));
    // an event for a request the child never announced (attached late)
    r.handle("CHILD", "Network.loadingFinished", finished("7.1", 10, 999));
    r.handle("CHILD", "Network.loadingFailed", { requestId: "7.1", timestamp: 100.01 });
    r.handle("CHILD", "Network.requestServedFromCache", { requestId: "7.1" });
    const [q] = r.requests();
    expect(q!.encoded).toBeUndefined();
    expect(q!.endEpochMs).toBeUndefined();
    expect(q!.failedEpochMs).toBeUndefined();
    expect(q!.fromCache).toBeUndefined();
  });

  it("scopes failures and cache hits to their target", () => {
    const r = new NetworkRecorder();
    r.handle(PAGE_SCOPE, "Network.requestWillBeSent", sent("1", "http://a.test/p", 0));
    r.handle("C", "Network.requestWillBeSent", sent("1", "http://b.test/c", 0));
    r.handle("C", "Network.loadingFailed", { requestId: "1", timestamp: 100.03 });
    r.handle(PAGE_SCOPE, "Network.requestServedFromCache", { requestId: "1" });
    const [p, c] = r.requests();
    expect(p!.fromCache).toBe(true);
    expect(p!.failedEpochMs).toBeUndefined();
    expect(c!.fromCache).toBeUndefined();
    expect(c!.failedEpochMs).toBeCloseTo(at(30), 3);
  });

  it("keeps a redirect chain as one request (its last hop)", () => {
    const r = new NetworkRecorder();
    r.handle("C", "Network.requestWillBeSent", sent("9", "http://b.test/old", 0));
    r.handle("C", "Network.requestWillBeSent", sent("9", "http://b.test/new", 5));
    r.handle("C", "Network.loadingFinished", finished("9", 9, 10));
    expect(r.requests().map((q) => q.url)).toEqual(["http://b.test/new"]);
  });

  it("ignores events it does not read", () => {
    const r = new NetworkRecorder();
    r.handle("C", "Network.dataReceived", { requestId: "1", dataLength: 5 });
    r.handle("C", "Page.frameNavigated", {});
    expect(r.requests()).toEqual([]);
  });

  it("attributes child-target requests to the span they started in", () => {
    const r = new NetworkRecorder();
    const NAV = "AF187F9BA9A884AD1037EFF66F614AF4";
    // span A: the page loads and creates a cross-site iframe
    r.handle(PAGE_SCOPE, "Network.requestWillBeSent", sent("1.1", "http://a.test/", 0, "Document"));
    r.handle(PAGE_SCOPE, "Network.loadingFinished", finished("1.1", 10, 2048));
    r.handle(PAGE_SCOPE, "Network.requestWillBeSent", sent(NAV, "http://b.test/embed", 20, "Document"));
    r.handle("OOPIF", "Network.loadingFinished", finished(NAV, 30, 1024));
    r.handle("OOPIF", "Network.requestWillBeSent", sent("2.1", "http://b.test/player.js", 40));
    r.handle("OOPIF", "Network.loadingFinished", finished("2.1", 400, 150 * 1024));
    // started in span A, still running at report time
    r.handle("OOPIF", "Network.requestWillBeSent", sent("2.2", "http://b.test/poster.png", 60, "Image"));
    // span B: the iframe polls
    r.handle("OOPIF", "Network.requestWillBeSent", sent("2.3", "http://b.test/poll", 600, "Fetch"));
    r.handle("OOPIF", "Network.loadingFinished", finished("2.3", 650, 1024));

    const reqs = r.requests();
    const a = buildSpanNetwork({ startEpochMs: at(0), endEpochMs: at(100) }, reqs, "a.test");
    expect(a.requestCount).toBe(4);
    expect(a.encodedKB).toBe(2 + 1 + 150);
    expect(a.thirdParty.requestCount).toBe(3);
    expect(a.thirdParty.encodedKB).toBe(151);
    expect(a.thirdParty.byDomain.map((d) => d.domain)).toEqual(["b.test"]);
    // settled at the player's end; the poster is still in flight
    expect(a.settledMs).toBe(400);
    expect(a.settledUnfinished).toBe(true);
    expect(a.requests.find((q) => q.url.endsWith("poster.png"))?.unfinished).toBe(true);

    const b = buildSpanNetwork({ startEpochMs: at(550), endEpochMs: at(700) }, reqs, "a.test");
    expect(b.requestCount).toBe(1);
    expect(b.encodedKB).toBe(1);
    expect(b.settledMs).toBe(100);
    expect(b.settledUnfinished).toBeUndefined();
  });
});
