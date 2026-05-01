import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serverFaults } from "./server-faults.js";

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
    const response = await fault.maybeInject(req("/api/x"));
    expect(response).not.toBeNull();
    expect(response!.status).toBe(503);
    const body = await response!.json();
    expect(body.error).toMatch(/chaos/);
    expect(body.path).toBe("/api/x");
  });

  it("honours status5xxCode override", async () => {
    const fault = serverFaults({ status5xxRate: 1, status5xxCode: 500 });
    const response = await fault.maybeInject(req("/api/x"));
    expect(response!.status).toBe(500);
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
      expect(result).toBeNull();
    });

    it("returns null after latency (handler runs after delay)", async () => {
      const fault = serverFaults({ latencyRate: 1, latencyMs: 50 });
      const promise = fault.maybeInject(req("/api/x"));
      await vi.advanceTimersByTimeAsync(50);
      expect(await promise).toBeNull();
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

  it("invokes observer.onFault for 5xx faults", async () => {
    const onFault = vi.fn();
    const fault = serverFaults({
      status5xxRate: 1,
      observer: { onFault },
    });
    await fault.maybeInject(req("/api/x"));
    expect(onFault).toHaveBeenCalledWith("5xx", expect.objectContaining({ status: 503, path: "/api/x" }));
  });

  it("invokes observer.onFault for latency faults", async () => {
    const onFault = vi.fn();
    const fault = serverFaults({
      latencyRate: 1,
      latencyMs: 1,
      observer: { onFault },
    });
    await fault.maybeInject(req("/api/x"));
    expect(onFault).toHaveBeenCalledWith("latency", expect.objectContaining({ ms: 1, path: "/api/x" }));
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
});
