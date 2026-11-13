import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inFlightCount } from "./egress.js";
import { createFaultEgress, KitesurfFaultsError, type FaultRule } from "./index.js";

// Waits are driven by fake timers only: a delay test that sleeps for real is
// slow, and flaky under a loaded CI runner exactly where the ordering matters.

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const CART = "https://shop.invalid/api/cart";
const delay = (ms: number, over: Partial<FaultRule> = {}): FaultRule => ({
  name: "slow",
  urlPattern: /\/api\/cart$/,
  fault: { kind: "delay", ms },
  ...over,
});

function recordingUpstream() {
  const calls: Request[] = [];
  return {
    calls,
    fetch: vi.fn(async (req: Request) => {
      calls.push(req);
      return new Response(`ok:${calls.length}`);
    }),
  };
}

/** Settles `p` into a value so a test can look at it without awaiting it. */
function track<T>(p: Promise<T>) {
  const state: { done: boolean; value?: T; error?: unknown } = { done: false };
  p.then(
    (value) => Object.assign(state, { done: true, value }),
    (error: unknown) => Object.assign(state, { done: true, error }),
  );
  return state;
}

/**
 * Counts the "abort" listeners added to `signal` and not removed since. Only
 * an explicit `removeEventListener` takes one off: a `{ once: true }` listener
 * that fired is gone from the signal, but the session is expected to remove
 * the listeners on its other signals itself, and this keeps the test honest
 * about that without reaching into the runtime's internals.
 */
function listenerProbe(signal: AbortSignal): () => number {
  const live = new Set<unknown>();
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: AddEventListenerOptions) => {
    if (type === "abort") live.add(fn);
    add(type, fn, opts);
  }) as AbortSignal["addEventListener"];
  signal.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, opts?: EventListenerOptions) => {
    if (type === "abort") live.delete(fn);
    remove(type, fn, opts);
  }) as AbortSignal["removeEventListener"];
  return () => live.size;
}

describe("delay", () => {
  it("does not call upstream before the delay ends, and calls it once after", async () => {
    const up = recordingUpstream();
    const session = createFaultEgress(up, { seed: 1, rules: [delay(1000)] });
    const req = new Request(CART);
    const abortListeners = listenerProbe(req.signal);
    const res = track(session.fetch(req));

    await vi.advanceTimersByTimeAsync(999);
    expect(up.fetch).not.toHaveBeenCalled();
    expect(res.done).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(up.fetch).toHaveBeenCalledTimes(1);
    expect(res.done).toBe(true);
    expect(await res.value!.text()).toBe("ok:1");
    expect(vi.getTimerCount()).toBe(0);
    expect(abortListeners()).toBe(0);
    expect(session.stats()).toEqual([{ rule: "slow", matched: 1, injected: 1 }]);
  });

  it("decides and counts before the wait, so arrival order sets the occurrence", async () => {
    // A arrives first and draws occurrence 0 ("inject": wait 100 ms). B
    // arrives next, draws occurrence 1 ("pass") and reaches upstream first.
    // If occurrences were handed out when a wait ended, B would be 0.
    const up = recordingUpstream();
    const session = createFaultEgress(up, {
      seed: 1,
      rules: [delay(100, { name: "x", urlPattern: /\/api\/x\?/, schedule: { decisions: ["inject", "pass"] } })],
    });
    const a = track(session.fetch(new Request("https://shop.invalid/api/x?who=a")));
    const b = track(session.fetch(new Request("https://shop.invalid/api/x?who=b")));
    expect(session.stats()).toEqual([{ rule: "x", matched: 2, injected: 1 }]);

    await vi.advanceTimersByTimeAsync(0);
    expect(up.calls.map((r) => new URL(r.url).searchParams.get("who"))).toEqual(["b"]);
    expect(b.done).toBe(true);
    expect(a.done).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    expect(up.calls.map((r) => new URL(r.url).searchParams.get("who"))).toEqual(["b", "a"]);
    expect(a.done).toBe(true);
    expect(session.stats()).toEqual([{ rule: "x", matched: 2, injected: 1 }]);
  });
});

describe("Request.signal", () => {
  it("rejects a request that is already aborted without counting it", async () => {
    const up = recordingUpstream();
    const session = createFaultEgress(up, { seed: 1, rules: [delay(1000)] });
    const ctl = new AbortController();
    ctl.abort();
    await expect(session.fetch(new Request(CART, { signal: ctl.signal }))).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(session.stats()).toEqual([{ rule: "slow", matched: 0, injected: 0 }]);
    expect(up.fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends a wait with the abort reason, never calls upstream and leaves no timer or listener", async () => {
    const up = recordingUpstream();
    const session = createFaultEgress(up, { seed: 1, rules: [delay(1000)] });
    const ctl = new AbortController();
    const req = new Request(CART, { signal: ctl.signal });
    const abortListeners = listenerProbe(req.signal);
    const res = track(session.fetch(req));
    expect(abortListeners()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(500);
    ctl.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(res.done).toBe(true);
    expect((res.error as DOMException).name).toBe("AbortError");
    expect(vi.getTimerCount()).toBe(0);
    expect(abortListeners()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(up.fetch).not.toHaveBeenCalled();
    // The decision was made when the request arrived; aborting the wait does
    // not take it back.
    expect(session.stats()).toEqual([{ rule: "slow", matched: 1, injected: 1 }]);
  });

  it("is passed on to upstream for a request that is let through", async () => {
    const up = recordingUpstream();
    const session = createFaultEgress(up, { seed: 1, rules: [] });
    const ctl = new AbortController();
    await session.fetch(new Request(CART, { signal: ctl.signal }));
    const forwarded = up.calls[0]!;
    expect(forwarded.signal.aborted).toBe(false);
    ctl.abort();
    expect(forwarded.signal.aborted).toBe(true);
  });
});

describe("dispose()", () => {
  it("ends a pending wait without calling upstream and leaves no timer or listener", async () => {
    const up = recordingUpstream();
    const session = createFaultEgress(up, { seed: 1, rules: [delay(1000)] });
    const req = new Request(CART);
    const abortListeners = listenerProbe(req.signal);
    const res = track(session.fetch(req));
    await vi.advanceTimersByTimeAsync(10);

    await session.dispose();
    await vi.advanceTimersByTimeAsync(0);

    expect(res.done).toBe(true);
    expect(res.error).toBeInstanceOf(KitesurfFaultsError);
    expect((res.error as KitesurfFaultsError).code).toBe("disposed");
    expect(vi.getTimerCount()).toBe(0);
    expect(abortListeners()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(up.fetch).not.toHaveBeenCalled();
  });

  it("can be called twice, and a fetch after it rejects without counting", async () => {
    const up = recordingUpstream();
    const session = createFaultEgress(up, { seed: 1, rules: [delay(0)] });
    await expect(Promise.all([session.dispose(), session.dispose()])).resolves.toEqual([undefined, undefined]);
    await expect(session.dispose()).resolves.toBeUndefined();

    await expect(session.fetch(new Request(CART))).rejects.toMatchObject({ code: "disposed" });
    expect(session.stats()).toEqual([{ rule: "slow", matched: 0, injected: 0 }]);
    expect(up.fetch).not.toHaveBeenCalled();
  });

  it("aborts an upstream call in flight and cancels a Response that arrives too late", async () => {
    let release!: (res: Response) => void;
    const seen: Request[] = [];
    const up = {
      fetch: vi.fn(
        (req: Request) =>
          new Promise<Response>((resolve) => {
            seen.push(req);
            release = resolve;
          }),
      ),
    };
    const session = createFaultEgress(up, { seed: 1, rules: [] });
    const res = track(session.fetch(new Request(CART)));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.signal.aborted).toBe(false);

    const disposed = track(session.dispose());
    await vi.advanceTimersByTimeAsync(0);
    // dispose does not wait for upstream to give up.
    expect(disposed.done).toBe(true);
    expect(seen[0]!.signal.aborted).toBe(true);

    // An upstream that ignores its signal and answers anyway: the session owns
    // that Response and will not hand it out, so it cancels the body.
    const cancel = vi.fn(async () => {});
    const body = new ReadableStream({ cancel });
    release(new Response(body));
    await vi.advanceTimersByTimeAsync(0);

    expect(res.done).toBe(true);
    expect((res.error as KitesurfFaultsError).code).toBe("disposed");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("passes an upstream failure through unchanged while the session is live", async () => {
    const boom = new TypeError("upstream down");
    const session = createFaultEgress({ fetch: async () => Promise.reject(boom) }, { seed: 1, rules: [] });
    await expect(session.fetch(new Request(CART))).rejects.toBe(boom);
  });
});

// The session's own bookkeeping: one AbortController per wait or upstream
// call, held only while that call is pending. Timers and listeners on the
// caller's signal are checked above; these check that nothing stays in the
// session's set either, which no caller-visible behaviour would show until
// a long-lived run had piled them up.
describe("in-flight bookkeeping", () => {
  it("is empty again after a delay that ran to the end", async () => {
    const up = recordingUpstream();
    const session = createFaultEgress(up, { seed: 1, rules: [delay(100)] });
    const res = track(session.fetch(new Request(CART)));
    await vi.advanceTimersByTimeAsync(10);
    expect(inFlightCount(session)).toBe(1);
    await vi.advanceTimersByTimeAsync(90);
    expect(res.done).toBe(true);
    expect(inFlightCount(session)).toBe(0);
  });

  it("is empty again after the caller aborts a wait", async () => {
    const session = createFaultEgress(recordingUpstream(), { seed: 1, rules: [delay(1000)] });
    const ctl = new AbortController();
    const res = track(session.fetch(new Request(CART, { signal: ctl.signal })));
    await vi.advanceTimersByTimeAsync(10);
    ctl.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(res.done).toBe(true);
    expect(inFlightCount(session)).toBe(0);
  });

  it("is empty after dispose with a wait and an upstream call pending", async () => {
    const up = { fetch: vi.fn(() => new Promise<Response>(() => {})) };
    const session = createFaultEgress(up, { seed: 1, rules: [delay(1000)] });
    track(session.fetch(new Request(CART)));
    track(session.fetch(new Request("https://shop.invalid/other")));
    await vi.advanceTimersByTimeAsync(0);
    expect(inFlightCount(session)).toBe(2);
    await session.dispose();
    expect(inFlightCount(session)).toBe(0);
  });

  it("is empty again when upstream throws instead of rejecting", async () => {
    const sync = new Error("sync");
    const session = createFaultEgress(
      {
        fetch: () => {
          throw sync;
        },
      },
      { seed: 1, rules: [] },
    );
    await expect(session.fetch(new Request(CART))).rejects.toBe(sync);
    expect(inFlightCount(session)).toBe(0);
  });

  it("is empty again when the request cannot be rebuilt for upstream", async () => {
    const up = recordingUpstream();
    const session = createFaultEgress(up, { seed: 1, rules: [] });
    // A Request whose body was already read cannot be copied into a new one.
    const used = new Request(CART, { method: "POST", body: "x" });
    await used.text();
    await expect(session.fetch(used)).rejects.toBeInstanceOf(TypeError);
    expect(up.fetch).not.toHaveBeenCalled();
    expect(inFlightCount(session)).toBe(0);
  });

  it("reports a synchronous throw during dispose as disposed, like an async one", async () => {
    let session!: ReturnType<typeof createFaultEgress>;
    session = createFaultEgress(
      {
        fetch: () => {
          void session.dispose();
          throw new Error("sync");
        },
      },
      { seed: 1, rules: [] },
    );
    await expect(session.fetch(new Request(CART))).rejects.toMatchObject({ code: "disposed" });
    expect(inFlightCount(session)).toBe(0);
  });
});
