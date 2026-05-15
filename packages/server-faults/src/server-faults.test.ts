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

  describe("abort", () => {
    it("returns null when abortRate is 0", async () => {
      const fault = serverFaults({ abortRate: 0 });
      for (let i = 0; i < 50; i += 1) {
        expect(await fault.maybeInject(req(`/api/${i}`))).toBeNull();
      }
    });

    it("always returns an abort verdict when abortRate=1", async () => {
      const fault = serverFaults({ abortRate: 1 });
      const v = await fault.maybeInject(req("/api/x"));
      expect(v?.kind).toBe("abort");
      const abort = v as { kind: "abort"; abortStyle: "hangup" | "reset"; attrs: FaultAttrs };
      expect(abort.abortStyle).toBe("hangup");
      expect(abort.attrs).toEqual({
        kind: "abort",
        path: "/api/x",
        method: "GET",
        abortStyle: "hangup",
      });
    });

    it("honours abortStyle=reset", async () => {
      const fault = serverFaults({ abortRate: 1, abortStyle: "reset" });
      const v = await fault.maybeInject(req("/api/x"));
      expect((v as { abortStyle: string }).abortStyle).toBe("reset");
      expect((v as { attrs: FaultAttrs }).attrs.abortStyle).toBe("reset");
    });

    it("invokes observer.onFault for abort faults", async () => {
      const onFault = vi.fn();
      const fault = serverFaults({
        abortRate: 1,
        abortStyle: "reset",
        observer: { onFault },
      });
      await fault.maybeInject(req("/api/x"));
      expect(onFault).toHaveBeenCalledWith("abort", {
        kind: "abort",
        path: "/api/x",
        method: "GET",
        abortStyle: "reset",
      });
    });

    it("populates traceId on abort events too", async () => {
      const TP = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
      const onFault = vi.fn();
      const fault = serverFaults({ abortRate: 1, observer: { onFault } });
      await fault.maybeInject(
        new Request("https://test.local/api/x", { headers: { traceparent: TP } }),
      );
      expect(onFault).toHaveBeenCalledWith(
        "abort",
        expect.objectContaining({ traceId: "0af7651916cd43dd8448eb211c80319c" }),
      );
    });

    it("short-circuits 5xx and latency rolls when abort wins", async () => {
      const onFault = vi.fn();
      const fault = serverFaults({
        abortRate: 1,
        status5xxRate: 1,
        latencyRate: 1,
        latencyMs: 1,
        observer: { onFault },
      });
      const v = await fault.maybeInject(req("/api/x"));
      expect(v?.kind).toBe("abort");
      expect(onFault).toHaveBeenCalledTimes(1);
      expect(onFault).toHaveBeenCalledWith("abort", expect.anything());
    });
  });

  describe("partialResponse", () => {
    it("returns a partial verdict carrying afterBytes when raffle wins", async () => {
      const fault = serverFaults({ partialResponseRate: 1, partialResponseAfterBytes: 64 });
      const v = await fault.maybeInject(req("/api/x"));
      expect(v?.kind).toBe("partial");
      expect((v as { afterBytes: number }).afterBytes).toBe(64);
      expect((v as { attrs: FaultAttrs }).attrs).toEqual({
        kind: "partial",
        path: "/api/x",
        method: "GET",
        afterBytes: 64,
      });
    });

    it("defaults afterBytes to 0 when unset", async () => {
      const fault = serverFaults({ partialResponseRate: 1 });
      const v = await fault.maybeInject(req("/api/x"));
      expect((v as { afterBytes: number }).afterBytes).toBe(0);
    });

    it("invokes observer.onFault for partial faults", async () => {
      const onFault = vi.fn();
      const fault = serverFaults({
        partialResponseRate: 1,
        partialResponseAfterBytes: 128,
        observer: { onFault },
      });
      await fault.maybeInject(req("/api/x"));
      expect(onFault).toHaveBeenCalledWith("partial", {
        kind: "partial",
        path: "/api/x",
        method: "GET",
        afterBytes: 128,
      });
    });

    it("rolls after abort/5xx — abort wins over partial", async () => {
      const onFault = vi.fn();
      const fault = serverFaults({
        abortRate: 1,
        partialResponseRate: 1,
        observer: { onFault },
      });
      const v = await fault.maybeInject(req("/api/x"));
      expect(v?.kind).toBe("abort");
      expect(onFault).toHaveBeenCalledTimes(1);
    });

    it("rolls before latency — partial wins over latency", async () => {
      const onFault = vi.fn();
      const fault = serverFaults({
        partialResponseRate: 1,
        latencyRate: 1,
        latencyMs: 1,
        observer: { onFault },
      });
      const v = await fault.maybeInject(req("/api/x"));
      expect(v?.kind).toBe("partial");
      expect(onFault).toHaveBeenCalledTimes(1);
      expect(onFault).toHaveBeenCalledWith("partial", expect.anything());
    });
  });

  describe("statusFlapping", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns 5xx during the bad slice of each window", async () => {
      // window = 30s, bad = 5s. At t=0 (start of period) the request is bad;
      // at t=10s it is healthy.
      vi.setSystemTime(0);
      const fault = serverFaults({ statusFlapping: { windowMs: 30_000, badMs: 5_000 } });
      const badV = await fault.maybeInject(req("/api/x"));
      expect(badV?.kind).toBe("synthetic");
      expect((badV as { response: Response }).response.status).toBe(503);

      vi.setSystemTime(10_000);
      const okV = await fault.maybeInject(req("/api/x"));
      expect(okV).toBeNull();
    });

    it("emits via observer.onFault as kind '5xx' (same wire outcome as status5xxRate)", async () => {
      vi.setSystemTime(0);
      const onFault = vi.fn();
      const fault = serverFaults({
        statusFlapping: { windowMs: 30_000, badMs: 5_000 },
        observer: { onFault },
      });
      await fault.maybeInject(req("/api/x"));
      expect(onFault).toHaveBeenCalledWith("5xx", expect.objectContaining({ kind: "5xx" }));
    });

    it("honours statusFlapping.code override", async () => {
      vi.setSystemTime(0);
      const fault = serverFaults({
        statusFlapping: { code: 504, windowMs: 30_000, badMs: 5_000 },
      });
      const v = await fault.maybeInject(req("/api/x"));
      expect((v as { response: Response }).response.status).toBe(504);
    });

    it("phaseOffsetMs shifts which calendar slice is bad", async () => {
      // Without offset, t=0 is bad (phase 0 < 5_000).
      // With offset=10_000, phase at t=0 becomes (0 - 10_000) mod 30_000 = 20_000 — healthy.
      vi.setSystemTime(0);
      const fault = serverFaults({
        statusFlapping: { windowMs: 30_000, badMs: 5_000, phaseOffsetMs: 10_000 },
      });
      expect(await fault.maybeInject(req("/api/x"))).toBeNull();
      // At t=10_000 the phase becomes 0 — bad.
      vi.setSystemTime(10_000);
      expect((await fault.maybeInject(req("/api/x")))?.kind).toBe("synthetic");
    });

    it("composes with status5xxRate via OR (statusFlapping wins inside the bad window)", async () => {
      vi.setSystemTime(0);
      const onFault = vi.fn();
      const fault = serverFaults({
        statusFlapping: { windowMs: 30_000, badMs: 5_000 },
        status5xxRate: 0, // would never roll on its own
        observer: { onFault },
      });
      // Inside the bad window — emits 5xx even though status5xxRate=0.
      const v = await fault.maybeInject(req("/api/x"));
      expect(v?.kind).toBe("synthetic");
      expect(onFault).toHaveBeenCalledTimes(1);
    });

    it("falls through to status5xxRate raffle when healthy", async () => {
      vi.setSystemTime(10_000); // healthy slice
      const fault = serverFaults({
        statusFlapping: { windowMs: 30_000, badMs: 5_000 },
        status5xxRate: 1, // always roll outside the bad window
      });
      const v = await fault.maybeInject(req("/api/x"));
      expect(v?.kind).toBe("synthetic");
    });

    it("abort still wins over statusFlapping", async () => {
      vi.setSystemTime(0); // bad slice
      const fault = serverFaults({
        abortRate: 1,
        statusFlapping: { windowMs: 30_000, badMs: 5_000 },
      });
      const v = await fault.maybeInject(req("/api/x"));
      expect(v?.kind).toBe("abort");
    });

    it("metadataHeader works on flapped 5xx (same wire path as raffle 5xx)", async () => {
      vi.setSystemTime(0);
      const fault = serverFaults({
        statusFlapping: { windowMs: 30_000, badMs: 5_000 },
        metadataHeader: true,
      });
      const v = await fault.maybeInject(req("/api/x"));
      const resp = (v as { response: Response }).response;
      expect(resp.headers.get("x-chaos-fault-kind")).toBe("5xx");
      expect(resp.headers.get("x-chaos-fault-target-status")).toBe("503");
    });

    it("ignores the gate when windowMs or badMs is 0", async () => {
      vi.setSystemTime(0);
      const a = serverFaults({ statusFlapping: { windowMs: 0, badMs: 5_000 } });
      expect(await a.maybeInject(req("/api/x"))).toBeNull();
      const b = serverFaults({ statusFlapping: { windowMs: 30_000, badMs: 0 } });
      expect(await b.maybeInject(req("/api/x"))).toBeNull();
    });

    it("respects bypassHeader (no fault even inside the bad window)", async () => {
      vi.setSystemTime(0);
      const fault = serverFaults({
        statusFlapping: { windowMs: 30_000, badMs: 5_000 },
        bypassHeader: "x-chaos-bypass",
      });
      const r = new Request("https://test.local/api/x", {
        headers: { "x-chaos-bypass": "1" },
      });
      expect(await fault.maybeInject(r)).toBeNull();
    });

    it("respects exemptPathPattern (no fault on exempt paths)", async () => {
      vi.setSystemTime(0);
      const fault = serverFaults({
        statusFlapping: { windowMs: 30_000, badMs: 5_000 },
        exemptPathPattern: /^\/health/,
      });
      expect(await fault.maybeInject(req("/health"))).toBeNull();
      expect((await fault.maybeInject(req("/api/x")))?.kind).toBe("synthetic");
    });

    it("respects pathPattern (non-matching paths fall through)", async () => {
      vi.setSystemTime(0);
      const fault = serverFaults({
        statusFlapping: { windowMs: 30_000, badMs: 5_000 },
        pathPattern: /^\/api\//,
      });
      expect(await fault.maybeInject(req("/static/x"))).toBeNull();
      expect((await fault.maybeInject(req("/api/x")))?.kind).toBe("synthetic");
    });

    it("handles negative wall-clock values gracefully (e.g. Date.now() < phaseOffsetMs)", async () => {
      // (Date.now() - phaseOffsetMs) can go negative; without the JS modulo
      // correction the result would be a negative phase that always reads
      // as < badMs. Verify the gate behaves sanely when offset > now.
      vi.setSystemTime(100);
      const fault = serverFaults({
        statusFlapping: { windowMs: 30_000, badMs: 5_000, phaseOffsetMs: 10_000 },
      });
      // phase = ((100 - 10_000) mod 30_000 + 30_000) mod 30_000 = 20_100 → healthy
      expect(await fault.maybeInject(req("/api/x"))).toBeNull();
    });
  });

  describe("slowStreaming", () => {
    it("returns a slowStream verdict when raffle wins", async () => {
      const fault = serverFaults({
        slowStreaming: { rate: 1, chunkDelayMs: 250 },
      });
      const v = await fault.maybeInject(req("/api/x"));
      expect(v?.kind).toBe("slowStream");
      expect((v as { chunkDelayMs: number }).chunkDelayMs).toBe(250);
      expect((v as { attrs: FaultAttrs }).attrs).toEqual({
        kind: "slowStream",
        path: "/api/x",
        method: "GET",
        chunkDelayMs: 250,
      });
    });

    it("carries chunkSize when configured", async () => {
      const fault = serverFaults({
        slowStreaming: { rate: 1, chunkDelayMs: 50, chunkSize: 128 },
      });
      const v = await fault.maybeInject(req("/api/x"));
      expect((v as { chunkSize?: number }).chunkSize).toBe(128);
      expect((v as { attrs: FaultAttrs }).attrs.chunkSize).toBe(128);
    });

    it("invokes observer.onFault for slowStream faults", async () => {
      const onFault = vi.fn();
      const fault = serverFaults({
        slowStreaming: { rate: 1, chunkDelayMs: 100 },
        observer: { onFault },
      });
      await fault.maybeInject(req("/api/x"));
      expect(onFault).toHaveBeenCalledWith("slowStream", {
        kind: "slowStream",
        path: "/api/x",
        method: "GET",
        chunkDelayMs: 100,
      });
    });

    it("rolls after partial — partial wins over slowStream", async () => {
      const onFault = vi.fn();
      const fault = serverFaults({
        partialResponseRate: 1,
        slowStreaming: { rate: 1, chunkDelayMs: 1 },
        observer: { onFault },
      });
      const v = await fault.maybeInject(req("/api/x"));
      expect(v?.kind).toBe("partial");
    });

    it("rolls before latency — slowStream wins over latency", async () => {
      const onFault = vi.fn();
      const fault = serverFaults({
        slowStreaming: { rate: 1, chunkDelayMs: 1 },
        latencyRate: 1,
        latencyMs: 1,
        observer: { onFault },
      });
      const v = await fault.maybeInject(req("/api/x"));
      expect(v?.kind).toBe("slowStream");
      expect(onFault).toHaveBeenCalledTimes(1);
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

    it("maps chunkDelayMs and chunkSize for slowStream verdicts", () => {
      const out = toOtelAttrs({
        kind: "slowStream",
        path: "/api/x",
        method: "GET",
        chunkDelayMs: 500,
        chunkSize: 256,
      });
      expect(out).toEqual({
        "fault.kind": "slowStream",
        "fault.path": "/api/x",
        "fault.method": "GET",
        "fault.chunk_delay_ms": 500,
        "fault.chunk_size": 256,
      });
    });

    it("maps afterBytes for partial verdicts", () => {
      const out = toOtelAttrs({
        kind: "partial",
        path: "/api/x",
        method: "GET",
        afterBytes: 128,
      });
      expect(out).toEqual({
        "fault.kind": "partial",
        "fault.path": "/api/x",
        "fault.method": "GET",
        "fault.after_bytes": 128,
      });
    });

    it("maps abortStyle for abort verdicts", () => {
      const out = toOtelAttrs({
        kind: "abort",
        path: "/api/x",
        method: "GET",
        abortStyle: "reset",
      });
      expect(out).toEqual({
        "fault.kind": "abort",
        "fault.path": "/api/x",
        "fault.method": "GET",
        "fault.abort_style": "reset",
      });
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
