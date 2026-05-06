import { describe, expect, it, vi } from "vitest";
import { wrapKv, type KvLike } from "./kv.js";

function fakeKv(overrides: Partial<KvLike> = {}): KvLike {
  return {
    get: vi.fn(async () => "real-value"),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ keys: [], list_complete: true })),
    ...overrides,
  };
}

describe("wrapKv", () => {
  it("passes calls through unchanged at rate=0", async () => {
    const inner = fakeKv();
    const wrapped = wrapKv(inner, { rate: 0 });
    expect(await wrapped.get("k")).toBe("real-value");
    await wrapped.put("k", "v");
    await wrapped.delete("k");
    await wrapped.list();
    expect(inner.get).toHaveBeenCalledTimes(1);
    expect(inner.put).toHaveBeenCalledTimes(1);
    expect(inner.delete).toHaveBeenCalledTimes(1);
    expect(inner.list).toHaveBeenCalledTimes(1);
  });

  it("throws on every call at rate=1 with kind=throw", async () => {
    const inner = fakeKv();
    const wrapped = wrapKv(inner, { rate: 1, kinds: ["throw"] });
    await expect(wrapped.get("k")).rejects.toThrow(/kv\.throw/);
    await expect(wrapped.put("k", "v")).rejects.toThrow(/kv\.throw/);
    await expect(wrapped.delete("k")).rejects.toThrow(/kv\.throw/);
    await expect(wrapped.list()).rejects.toThrow(/kv\.throw/);
    // Inner KV is never touched when the raffle wins.
    expect(inner.get).not.toHaveBeenCalled();
    expect(inner.put).not.toHaveBeenCalled();
  });

  it("returns null on get at rate=1 with kind=miss; falls through on put/delete/list", async () => {
    const inner = fakeKv();
    const wrapped = wrapKv(inner, { rate: 1, kinds: ["miss"] });
    expect(await wrapped.get("k")).toBeNull();
    // miss is a get-only effect — put/delete/list must still hit the underlying KV
    await wrapped.put("k", "v");
    await wrapped.delete("k");
    await wrapped.list();
    expect(inner.put).toHaveBeenCalledTimes(1);
    expect(inner.delete).toHaveBeenCalledTimes(1);
    expect(inner.list).toHaveBeenCalledTimes(1);
    // ...and the inner get was bypassed
    expect(inner.get).not.toHaveBeenCalled();
  });

  it("invokes observer.onFault with semantic-convention attrs", async () => {
    const onFault = vi.fn();
    const inner = fakeKv();
    const wrapped = wrapKv(inner, {
      rate: 1,
      kinds: ["throw"],
      bindingName: "TODOS",
      observer: { onFault },
    });
    await expect(wrapped.get("foo")).rejects.toThrow();
    expect(onFault).toHaveBeenCalledWith("kv.throw", {
      "fault.kind": "kv.throw",
      "fault.target": "TODOS",
      "fault.path": "get:foo",
    });
  });

  it("is reproducible with the same seed", async () => {
    const inner = fakeKv();
    const a = wrapKv(inner, { rate: 0.5, seed: 42 });
    const b = wrapKv(inner, { rate: 0.5, seed: 42 });
    const aSeq: boolean[] = [];
    const bSeq: boolean[] = [];
    for (let i = 0; i < 20; i++) {
      aSeq.push(await a.get(`k${i}`).then(() => false).catch(() => true));
      bSeq.push(await b.get(`k${i}`).then(() => false).catch(() => true));
    }
    expect(aSeq).toEqual(bSeq);
  });
});
