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
