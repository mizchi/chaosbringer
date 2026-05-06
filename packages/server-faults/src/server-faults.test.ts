import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serverFaults, toOtelAttrs } from "./server-faults.js";
import type { FaultAttrs } from "./server-faults.js";

const req = (path: string) => new Request(`https://test.local${path}`);

describe("serverFaults", () => {
  it("returns null for every call when both rates are 0", async () => {
    const fault = serverFaults({});
    for (let i = 0; i < 100; i += 1) {
      expect(await fault.maybeInject(req("/api/x"))).toBeNull();
    }
  });

  it("always returns a 503 when status5xxRate=1", async () => {
    const fault = serverFaults({ status5xxRate: 1 });
    const v = await fault.maybeInject(req("/api/x"));
    expect(v?.kind).toBe("synthetic");
    const response = (v as { kind: "synthetic"; response: Response }).response;
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toMatch(/chaos/);
    expect(body.path).toBe("/api/x");
  });

  it("honours status5xxCode override", async () => {
    const fault = serverFaults({ status5xxRate: 1, status5xxCode: 500 });
    const v = await fault.maybeInject(req("/api/x"));
    expect((v as { kind: "synthetic"; response: Response }).response.status).toBe(500);
  });

  it("filters by pathPattern (RegExp form)", async () => {
    const fault = serverFaults({ status5xxRate: 1, pathPattern: /^\/api\// });
    expect(await fault.maybeInject(req("/health"))).toBeNull();
    expect(await fault.maybeInject(req("/api/users"))).not.toBeNull();
  });

  it("filters by pathPattern (string form)", async () => {
    const fault = serverFaults({ status5xxRate: 1, pathPattern: "^/api/" });
    expect(await fault.maybeInject(req("/health"))).toBeNull();
    expect(await fault.maybeInject(req("/api/users"))).not.toBeNull();
  });

  it("produces a reproducible fault sequence with the same seed", async () => {
    const a = serverFaults({ status5xxRate: 0.5, seed: 42 });
    const b = serverFaults({ status5xxRate: 0.5, seed: 42 });
    const aSeq: boolean[] = [];
    const bSeq: boolean[] = [];
    for (let i = 0; i < 20; i += 1) {
      aSeq.push((await a.maybeInject(req(`/api/${i}`))) !== null);
      bSeq.push((await b.maybeInject(req(`/api/${i}`))) !== null);
    }
    expect(aSeq).toEqual(bSeq);
  });

  it("different seeds produce different fault sequences", async () => {
    const a = serverFaults({ status5xxRate: 0.5, seed: 1 });
    const b = serverFaults({ status5xxRate: 0.5, seed: 2 });
    const aSeq: boolean[] = [];
    const bSeq: boolean[] = [];
    for (let i = 0; i < 20; i += 1) {
      aSeq.push((await a.maybeInject(req(`/api/${i}`))) !== null);
      bSeq.push((await b.maybeInject(req(`/api/${i}`))) !== null);
    }
    expect(aSeq).not.toEqual(bSeq);
  });

  describe("latency", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("delays the request by latencyMs (number)", async () => {
      const fault = serverFaults({ latencyRate: 1, latencyMs: 100 });
      const promise = fault.maybeInject(req("/api/x"));
      await vi.advanceTimersByTimeAsync(99);
      let resolved = false;
      promise.then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      const result = await promise;
      expect(result?.kind).toBe("annotate");
    });

    it("returns null after latency (handler runs after delay)", async () => {
      const fault = serverFaults({ latencyRate: 1, latencyMs: 50 });
      const promise = fault.maybeInject(req("/api/x"));
      await vi.advanceTimersByTimeAsync(50);
      expect((await promise)?.kind).toBe("annotate");
    });
  });

  it("latencyMs range stays within bounds", async () => {
    const fault = serverFaults({
      latencyRate: 1,
      latencyMs: { minMs: 50, maxMs: 100 },
    });
    const sleepSpy = vi.spyOn(globalThis, "setTimeout");
    for (let i = 0; i < 20; i += 1) {
      const p = fault.maybeInject(req(`/api/${i}`));
      // run all pending timers without using fake timers
      await new Promise((r) => setImmediate(r));
      await p;
    }
    for (const call of sleepSpy.mock.calls) {
      const ms = call[1] as number;
      expect(ms).toBeGreaterThanOrEqual(50);
      expect(ms).toBeLessThanOrEqual(100);
    }
    sleepSpy.mockRestore();
  });

  it("invokes observer.onFault for 5xx faults with semantic-convention attrs", async () => {
    const onFault = vi.fn();
    const fault = serverFaults({
      status5xxRate: 1,
      observer: { onFault },
    });
    await fault.maybeInject(req("/api/x"));
    expect(onFault).toHaveBeenCalledWith("5xx", {
      kind: "5xx",
      path: "/api/x",
      method: "GET",
      targetStatus: 503,
    });
  });

  it("invokes observer.onFault for latency faults with semantic-convention attrs", async () => {
    const onFault = vi.fn();
    const fault = serverFaults({
      latencyRate: 1,
      latencyMs: 1,
      observer: { onFault },
    });
    await fault.maybeInject(req("/api/x"));
    expect(onFault).toHaveBeenCalledWith("latency", {
      kind: "latency",
      path: "/api/x",
      method: "GET",
      latencyMs: 1,
    });
  });

  it("uppercases HTTP method in attrs (mirrors OTel http semantic convention)", async () => {
    const onFault = vi.fn();
    const fault = serverFaults({
      status5xxRate: 1,
      observer: { onFault },
    });
    const r = new Request("https://test.local/api/x", { method: "post" as string });
    await fault.maybeInject(r);
    expect(onFault).toHaveBeenCalledWith("5xx", expect.objectContaining({ method: "POST" }));
  });

  describe("bypassHeader", () => {
    it("skips fault raffle when the named header is present (case-insensitive)", async () => {
      const onFault = vi.fn();
      const fault = serverFaults({
        status5xxRate: 1,
        bypassHeader: "x-chaos-bypass",
        observer: { onFault },
      });
      const r = new Request("https://test.local/api/x", {
        headers: { "X-Chaos-Bypass": "1" },
      });
      expect(await fault.maybeInject(r)).toBeNull();
      expect(onFault).not.toHaveBeenCalled();
    });

    it("still rolls fault when the header is absent", async () => {
      const fault = serverFaults({
        status5xxRate: 1,
        bypassHeader: "x-chaos-bypass",
      });
      expect(await fault.maybeInject(req("/api/x"))).not.toBeNull();
    });

    it("ignores any other header value", async () => {
      const fault = serverFaults({
        status5xxRate: 1,
        bypassHeader: "x-chaos-bypass",
      });
      const r = new Request("https://test.local/api/x", {
        headers: { "x-some-other": "1" },
      });
      expect(await fault.maybeInject(r)).not.toBeNull();
    });
  });

  describe("exemptPathPattern", () => {
    it("skips fault raffle when pathname matches (RegExp)", async () => {
      const onFault = vi.fn();
      const fault = serverFaults({
        status5xxRate: 1,
        exemptPathPattern: /^\/api\/health/,
        observer: { onFault },
      });
      expect(await fault.maybeInject(req("/api/health"))).toBeNull();
      expect(await fault.maybeInject(req("/api/health/deep"))).toBeNull();
      expect(onFault).not.toHaveBeenCalled();
    });

    it("skips fault raffle when pathname matches (string)", async () => {
      const fault = serverFaults({
        status5xxRate: 1,
        exemptPathPattern: "^/api/health",
      });
      expect(await fault.maybeInject(req("/api/health"))).toBeNull();
    });

    it("still rolls fault for non-exempt paths", async () => {
      const fault = serverFaults({
        status5xxRate: 1,
        exemptPathPattern: /^\/api\/health/,
      });
      expect(await fault.maybeInject(req("/api/users"))).not.toBeNull();
    });

    it("exemption short-circuits before pathPattern", async () => {
      // exempt covers a sub-prefix of pathPattern. The exempt pathname matches
      // both, but exempt should win and the request should pass through.
      const fault = serverFaults({
        status5xxRate: 1,
        pathPattern: /^\/api\//,
        exemptPathPattern: /^\/api\/health/,
      });
      expect(await fault.maybeInject(req("/api/health"))).toBeNull();
      expect(await fault.maybeInject(req("/api/users"))).not.toBeNull();
    });
  });

  describe("stateless regex matching", () => {
    // `RegExp.test()` is stateful with the `g` or `y` flag — `lastIndex`
    // advances between calls, so a second call against the same input
    // would spuriously miss. Both pathPattern and exemptPathPattern must
    // be normalised before use.
    it("handles g-flagged exemptPathPattern across repeated calls", async () => {
      const fault = serverFaults({
        status5xxRate: 1,
        exemptPathPattern: /^\/api\/health/g,
      });
      // 50 consecutive calls; every one must be exempt.
      for (let i = 0; i < 50; i++) {
        expect(await fault.maybeInject(req("/api/health"))).toBeNull();
      }
    });

    it("handles g-flagged pathPattern across repeated calls", async () => {
      const fault = serverFaults({
        status5xxRate: 1,
        pathPattern: /^\/api\//g,
      });
      // Every matching call should land in the raffle and (with rate=1) inject.
      for (let i = 0; i < 50; i++) {
        expect(await fault.maybeInject(req("/api/x"))).not.toBeNull();
      }
    });

    it("preserves case-insensitive flag while stripping g/y", async () => {
      const fault = serverFaults({
        status5xxRate: 1,
        exemptPathPattern: /^\/API\/HEALTH/giy,
      });
      // i flag preserved -> /api/health and /API/HEALTH both exempt.
      expect(await fault.maybeInject(req("/api/health"))).toBeNull();
      expect(await fault.maybeInject(req("/API/HEALTH"))).toBeNull();
    });
  });

  it("does not roll latency raffle when 5xx already won", async () => {
    const onFault = vi.fn();
    const fault = serverFaults({
      status5xxRate: 1,
      latencyRate: 1,
      latencyMs: 1,
      observer: { onFault },
    });
    await fault.maybeInject(req("/api/x"));
    expect(onFault).toHaveBeenCalledTimes(1);
    expect(onFault).toHaveBeenCalledWith("5xx", expect.anything());
  });

  describe("traceId", () => {
    const TP = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

    it("populates traceId from a valid traceparent header (5xx)", async () => {
      const onFault = vi.fn();
      const fault = serverFaults({ status5xxRate: 1, observer: { onFault } });
      await fault.maybeInject(
        new Request("https://test.local/api/x", { headers: { traceparent: TP } }),
      );
      expect(onFault).toHaveBeenCalledWith(
        "5xx",
        expect.objectContaining({ traceId: "0af7651916cd43dd8448eb211c80319c" }),
      );
    });

    it("populates traceId on latency events too", async () => {
      const onFault = vi.fn();
      const fault = serverFaults({ latencyRate: 1, latencyMs: 1, observer: { onFault } });
      await fault.maybeInject(
        new Request("https://test.local/api/x", { headers: { traceparent: TP } }),
      );
      expect(onFault).toHaveBeenCalledWith(
        "latency",
        expect.objectContaining({ traceId: "0af7651916cd43dd8448eb211c80319c" }),
      );
    });

    it("omits traceId when traceparent is absent", async () => {
      const onFault = vi.fn();
      const fault = serverFaults({ status5xxRate: 1, observer: { onFault } });
      await fault.maybeInject(new Request("https://test.local/api/x"));
      const attrs = onFault.mock.calls[0][1] as Record<string, unknown>;
      expect("traceId" in attrs).toBe(false);
    });

    it("omits traceId when traceparent is malformed", async () => {
      const onFault = vi.fn();
      const fault = serverFaults({ status5xxRate: 1, observer: { onFault } });
      await fault.maybeInject(
        new Request("https://test.local/api/x", { headers: { traceparent: "garbage" } }),
      );
      const attrs = onFault.mock.calls[0][1] as Record<string, unknown>;
      expect("traceId" in attrs).toBe(false);
    });
  });

  describe("toOtelAttrs", () => {
    it("maps every populated camelCase key to its OTel dotted equivalent", () => {
      const out = toOtelAttrs({
        kind: "5xx",
        path: "/api/x",
        method: "GET",
        targetStatus: 503,
        traceId: "0af7651916cd43dd8448eb211c80319c",
      });
      expect(out).toEqual({
        "fault.kind": "5xx",
        "fault.path": "/api/x",
        "fault.method": "GET",
        "fault.target_status": 503,
        "fault.trace_id": "0af7651916cd43dd8448eb211c80319c",
      });
    });

    it("omits keys that are undefined", () => {
      const out = toOtelAttrs({ kind: "latency", path: "/x", method: "GET", latencyMs: 50 });
      expect(out).toEqual({
        "fault.kind": "latency",
        "fault.path": "/x",
        "fault.method": "GET",
        "fault.latency_ms": 50,
      });
      expect("fault.target_status" in out).toBe(false);
      expect("fault.trace_id" in out).toBe(false);
    });
  });

  describe("metadataHeader", () => {
    const TP = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

    it("attaches all 5xx attrs as kebab-case headers on synthetic responses", async () => {
      const fault = serverFaults({ status5xxRate: 1, metadataHeader: true });
      const r = new Request("https://test.local/api/x", { headers: { traceparent: TP } });
      const v = await fault.maybeInject(r);
      expect(v?.kind).toBe("synthetic");
      const resp = (v as { response: Response }).response;
      expect(resp.headers.get("x-chaos-fault-kind")).toBe("5xx");
      expect(resp.headers.get("x-chaos-fault-path")).toBe("/api/x");
      expect(resp.headers.get("x-chaos-fault-method")).toBe("GET");
      expect(resp.headers.get("x-chaos-fault-target-status")).toBe("503");
      expect(resp.headers.get("x-chaos-fault-trace-id")).toBe("0af7651916cd43dd8448eb211c80319c");
      expect(resp.headers.get("x-chaos-fault-latency-ms")).toBeNull();
    });

    it("does not attach headers when metadataHeader is unset", async () => {
      const fault = serverFaults({ status5xxRate: 1 });
      const v = await fault.maybeInject(new Request("https://test.local/api/x"));
      const resp = (v as { kind: "synthetic"; response: Response }).response;
      expect(resp.headers.get("x-chaos-fault-kind")).toBeNull();
    });

    it("honours custom prefix", async () => {
      const fault = serverFaults({ status5xxRate: 1, metadataHeader: { prefix: "x-my-fault" } });
      const v = await fault.maybeInject(new Request("https://test.local/api/x"));
      const resp = (v as { kind: "synthetic"; response: Response }).response;
      expect(resp.headers.get("x-my-fault-kind")).toBe("5xx");
      expect(resp.headers.get("x-chaos-fault-kind")).toBeNull();
    });

    it("returns annotate verdict carrying full attrs for latency (adapter must apply headers)", async () => {
      const fault = serverFaults({ latencyRate: 1, latencyMs: 1, metadataHeader: true });
      const r = new Request("https://test.local/api/x", { headers: { traceparent: TP } });
      const v = await fault.maybeInject(r);
      expect(v?.kind).toBe("annotate");
      const attrs = (v as { kind: "annotate"; attrs: FaultAttrs }).attrs;
      expect(attrs.kind).toBe("latency");
      expect(attrs.latencyMs).toBe(1);
      expect(attrs.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    });
  });
});
