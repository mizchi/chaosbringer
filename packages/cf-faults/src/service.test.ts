import { describe, expect, it, vi } from "vitest";
import { wrapServiceBinding, type FetcherLike } from "./service.js";

function fakeFetcher(): FetcherLike {
  return { fetch: vi.fn(async () => Response.json({ ok: true })) };
}

describe("wrapServiceBinding", () => {
  it("passes through when both rates are 0", async () => {
    const inner = fakeFetcher();
    const wrapped = wrapServiceBinding(inner, {});
    const r = await wrapped.fetch("https://b.local/enrich");
    expect(r.status).toBe(200);
    expect(inner.fetch).toHaveBeenCalledTimes(1);
  });

  it("returns synthetic 5xx at status5xxRate=1", async () => {
    const inner = fakeFetcher();
    const wrapped = wrapServiceBinding(inner, { status5xxRate: 1, status5xxCode: 502 });
    const r = await wrapped.fetch("https://b.local/enrich");
    expect(r.status).toBe(502);
    const body = await r.json();
    expect(body).toMatchObject({ status: 502 });
    expect(inner.fetch).not.toHaveBeenCalled();
  });

  it("throws at abortRate=1", async () => {
    const inner = fakeFetcher();
    const wrapped = wrapServiceBinding(inner, { abortRate: 1 });
    await expect(wrapped.fetch("https://b.local/enrich")).rejects.toThrow(/service\.abort/);
    expect(inner.fetch).not.toHaveBeenCalled();
  });

  it("5xx wins over abort when both rates are 1 (raffle order is deterministic)", async () => {
    const inner = fakeFetcher();
    const wrapped = wrapServiceBinding(inner, { status5xxRate: 1, abortRate: 1 });
    const r = await wrapped.fetch("https://b.local/enrich");
    expect(r.status).toBe(503);
  });

  it("invokes observer.onFault with semantic-convention attrs", async () => {
    const onFault = vi.fn();
    const inner = fakeFetcher();
    const wrapped = wrapServiceBinding(inner, {
      status5xxRate: 1,
      bindingName: "ENRICHER",
      observer: { onFault },
    });
    await wrapped.fetch("https://b.local/enrich/x?q=1");
    expect(onFault).toHaveBeenCalledWith("service.5xx", {
      "fault.kind": "service.5xx",
      "fault.target": "ENRICHER",
      "fault.path": "/enrich/x",
      "fault.target_status": 503,
    });
  });

  it("is reproducible with the same seed", async () => {
    const inner = fakeFetcher();
    const a = wrapServiceBinding(inner, { status5xxRate: 0.5, seed: 42 });
    const b = wrapServiceBinding(inner, { status5xxRate: 0.5, seed: 42 });
    const aSeq: number[] = [];
    const bSeq: number[] = [];
    for (let i = 0; i < 20; i++) {
      aSeq.push((await a.fetch(`https://b.local/${i}`)).status);
      bSeq.push((await b.fetch(`https://b.local/${i}`)).status);
    }
    expect(aSeq).toEqual(bSeq);
  });
});
