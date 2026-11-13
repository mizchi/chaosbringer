import { createRng } from "@mizchi/playwright-faults/network";
import { describe, expect, it, vi } from "vitest";
import {
  createFaultEgress,
  INJECTED_ABORT_MARKER,
  KitesurfFaultsError,
  type FaultRule,
} from "./index.js";

/** Records every request it is handed and answers each with a fresh 200. */
function recordingUpstream(make: () => Response = () => Response.json({ ok: true })) {
  const calls: Request[] = [];
  const responses: Response[] = [];
  return {
    calls,
    responses,
    fetch: vi.fn(async (req: Request) => {
      calls.push(req);
      const res = make();
      responses.push(res);
      return res;
    }),
  };
}

const CART = "https://shop.invalid/api/cart";

describe("requests the rules leave alone reach upstream once, unchanged", () => {
  const passCases: Array<[string, FaultRule[]]> = [
    ["empty rules", []],
    ["a rule that does not match the URL", [{ urlPattern: /\/api\/other$/, fault: { kind: "status", status: 503 } }]],
    ["a rule that does not match the method", [{ urlPattern: /\/api\/cart$/, methods: ["GET"], fault: { kind: "status", status: 503 } }]],
    ["probability 0", [{ urlPattern: /\/api\/cart$/, probability: 0, fault: { kind: "status", status: 503 } }]],
    ["a schedule that says pass", [{ urlPattern: /\/api\/cart$/, schedule: { decisions: ["pass"] }, fault: { kind: "status", status: 503 } }]],
  ];

  it.each(passCases)("%s", async (_label, rules) => {
    const up = recordingUpstream();
    const session = createFaultEgress(up, { seed: 1, rules });
    const original = new Request(CART, {
      method: "POST",
      headers: { "content-type": "application/json", "x-trace": "abc" },
      body: JSON.stringify({ sku: 7 }),
      credentials: "include",
      redirect: "manual",
    });
    const url = original.url;
    const method = original.method;
    const headers = [...original.headers];
    const credentials = original.credentials;
    const redirect = original.redirect;

    const res = await session.fetch(original);

    expect(up.fetch).toHaveBeenCalledTimes(1);
    const forwarded = up.calls[0]!;
    expect(forwarded.url).toBe(url);
    expect(forwarded.method).toBe(method);
    expect([...forwarded.headers]).toEqual(headers);
    expect(forwarded.credentials).toBe(credentials);
    expect(forwarded.redirect).toBe(redirect);
    expect(await forwarded.text()).toBe('{"sku":7}');
    // The upstream Response is handed back as it came: same object, body
    // still a stream nobody has read.
    expect(res).toBe(up.responses[0]);
    expect(res.bodyUsed).toBe(false);
  });
});

describe("status", () => {
  const cart503: FaultRule = {
    name: "cart-503-once",
    urlPattern: /\/api\/cart$/,
    methods: ["GET"],
    fault: { kind: "status", status: 503 },
    schedule: { decisions: ["inject"] },
  };

  it("answers the first GET with 503 and lets the retry through to upstream", async () => {
    const up = recordingUpstream();
    const session = createFaultEgress(up, { seed: 1, rules: [cart503] });

    const first = await session.fetch(new Request(CART));
    expect(first.status).toBe(503);
    expect(first.headers.get("content-type")).toBe("application/json");
    expect(await first.text()).toBe('{"error":503}');
    expect(up.fetch).not.toHaveBeenCalled();

    const second = await session.fetch(new Request(CART));
    expect(second.status).toBe(200);
    expect(up.fetch).toHaveBeenCalledTimes(1);

    expect(session.stats()).toEqual([{ rule: "cart-503-once", matched: 2, injected: 1 }]);
  });

  it("keeps an explicit empty body and honours a contentType override", async () => {
    const up = recordingUpstream();
    const session = createFaultEgress(up, {
      seed: 1,
      rules: [{ urlPattern: /\/api\/cart$/, fault: { kind: "status", status: 500, body: "", contentType: "text/plain" } }],
    });
    const res = await session.fetch(new Request(CART));
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).toBe("");
  });
});

describe("abort", () => {
  it("rejects with the injected-abort marker without calling upstream", async () => {
    const up = recordingUpstream();
    const session = createFaultEgress(up, {
      seed: 1,
      rules: [{ urlPattern: /\/api\/cart$/, fault: { kind: "abort" } }],
    });
    const err = await session.fetch(new Request(CART)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(KitesurfFaultsError);
    expect((err as KitesurfFaultsError).code).toBe("injected-abort");
    expect((err as KitesurfFaultsError).errorCode).toBe("failed");
    expect((err as Error).message).toBe(INJECTED_ABORT_MARKER);
    expect(up.fetch).not.toHaveBeenCalled();
    expect(session.stats()).toEqual([{ rule: "/\\/api\\/cart$/", matched: 1, injected: 1 }]);
  });

  it("is a rejected fetch, not an HTTP response the way a 503 is", async () => {
    const up = recordingUpstream();
    const aborting = createFaultEgress(up, {
      seed: 1,
      rules: [{ urlPattern: /\/api\/cart$/, fault: { kind: "abort" } }],
    });
    const failing = createFaultEgress(up, {
      seed: 1,
      rules: [{ urlPattern: /\/api\/cart$/, fault: { kind: "status", status: 503 } }],
    });
    const [a, s] = await Promise.allSettled([aborting.fetch(new Request(CART)), failing.fetch(new Request(CART))]);
    expect(a.status).toBe("rejected");
    expect(s.status).toBe("fulfilled");
    expect((s as PromiseFulfilledResult<Response>).value.status).toBe(503);
    expect(up.fetch).not.toHaveBeenCalled();
  });
});

describe("seeded decisions", () => {
  const coin: FaultRule[] = [{ urlPattern: /\/api\/cart$/, probability: 0.5, fault: { kind: "status", status: 503 } }];

  async function statuses(seed: number): Promise<number[]> {
    const session = createFaultEgress(recordingUpstream(), { seed, rules: coin });
    const out: number[] = [];
    for (let i = 0; i < 20; i++) out.push((await session.fetch(new Request(CART))).status);
    return out;
  }

  it("draws the same mulberry32 sequence as every other adapter for the same seed", async () => {
    // The oracle is the shared generator itself: one draw per request, inject
    // below p. A session that drew differently would make "seed 42" mean a
    // different run on Kitesurf than on Chromium.
    const rng = createRng(42);
    const expected = Array.from({ length: 20 }, () => (rng.next() < 0.5 ? 503 : 200));
    expect(await statuses(42)).toEqual(expected);
    expect(await statuses(42)).toEqual(expected);
    expect(await statuses(43)).not.toEqual(expected);
  });

  it("gives two sessions with one seed identical stats", async () => {
    const run = async () => {
      const session = createFaultEgress(recordingUpstream(), { seed: 42, rules: coin });
      for (let i = 0; i < 20; i++) await session.fetch(new Request(CART));
      return session.stats();
    };
    expect(await run()).toEqual(await run());
  });

  it("does not draw for a schedule or for probability 0", async () => {
    // Two parked rules in front of the coin must not shift its draws.
    const session = createFaultEgress(recordingUpstream(), {
      seed: 42,
      rules: [
        { urlPattern: /\/api\/cart$/, schedule: { decisions: ["pass"] }, fault: { kind: "status", status: 500 } },
        { urlPattern: /\/api\/cart$/, probability: 0, fault: { kind: "status", status: 502 } },
        ...coin,
      ],
    });
    const rng = createRng(42);
    for (let i = 0; i < 20; i++) {
      const want = rng.next() < 0.5 ? 503 : 200;
      expect((await session.fetch(new Request(CART))).status).toBe(want);
    }
  });
});

describe("rule order", () => {
  it("records a scheduled rule behind a winner as suppressed", async () => {
    const session = createFaultEgress(recordingUpstream(), {
      seed: 1,
      rules: [
        { name: "first", urlPattern: /\/api\/cart$/, fault: { kind: "status", status: 500 } },
        { name: "planned", urlPattern: /\/api\/cart$/, schedule: { decisions: ["inject", "pass"] }, fault: { kind: "status", status: 503 } },
      ],
    });
    expect((await session.fetch(new Request(CART))).status).toBe(500);
    expect((await session.fetch(new Request(CART))).status).toBe(500);
    expect(session.stats()).toEqual([
      { rule: "first", matched: 2, injected: 2 },
      { rule: "planned", matched: 2, injected: 0, suppressed: 1 },
    ]);
  });

  it("never consults a probability rule once an earlier rule won", async () => {
    const session = createFaultEgress(recordingUpstream(), {
      seed: 1,
      rules: [
        { name: "first", urlPattern: /\/api\/cart$/, fault: { kind: "status", status: 500 } },
        { name: "coin", urlPattern: /\/api\/cart$/, probability: 0.5, fault: { kind: "status", status: 503 } },
      ],
    });
    await session.fetch(new Request(CART));
    expect(session.stats()).toEqual([
      { rule: "first", matched: 1, injected: 1 },
      { rule: "coin", matched: 0, injected: 0 },
    ]);
  });

  it("matches methods case-insensitively", async () => {
    const session = createFaultEgress(recordingUpstream(), {
      seed: 1,
      rules: [{ urlPattern: /\/api\/cart$/, methods: ["post"], fault: { kind: "status", status: 503 } }],
    });
    expect((await session.fetch(new Request(CART, { method: "POST", body: "x" }))).status).toBe(503);
    expect((await session.fetch(new Request(CART))).status).toBe(200);
  });
});

describe("stats()", () => {
  it("returns a snapshot the caller cannot use to change the session", async () => {
    const session = createFaultEgress(recordingUpstream(), {
      seed: 1,
      rules: [{ name: "r", urlPattern: /\/api\/cart$/, fault: { kind: "status", status: 503 } }],
    });
    await session.fetch(new Request(CART));
    const snap = session.stats();
    snap[0]!.matched = 99;
    snap.push({ rule: "forged", matched: 1, injected: 1 });
    expect(session.stats()).toEqual([{ rule: "r", matched: 1, injected: 1 }]);
  });

  it("still reports the final counts after dispose", async () => {
    const session = createFaultEgress(recordingUpstream(), {
      seed: 1,
      rules: [{ name: "r", urlPattern: /\/api\/cart$/, fault: { kind: "status", status: 503 } }],
    });
    await session.fetch(new Request(CART));
    await session.dispose();
    expect(session.stats()).toEqual([{ rule: "r", matched: 1, injected: 1 }]);
  });
});

describe("the caller's configuration", () => {
  it("is neither mutated nor shared with the session", async () => {
    const pattern = /\/api\/cart$/g;
    const methods = Object.freeze(["GET"]) as unknown as string[];
    const decisions = Object.freeze(["inject", "pass"] as const);
    const fault = Object.freeze({ kind: "status", status: 503 } as const);
    const r = Object.freeze({ name: "cart", urlPattern: pattern, methods, fault, schedule: Object.freeze({ decisions }) });
    const rules = Object.freeze([r]);

    const session = createFaultEgress(recordingUpstream(), { seed: 1, rules });
    for (let i = 0; i < 3; i++) await session.fetch(new Request(CART));

    expect(pattern.lastIndex).toBe(0);
    expect(pattern.flags).toBe("g");
    expect(rules).toEqual([r]);
    expect(r.methods).toEqual(["GET"]);
    expect(session.stats()).toEqual([{ rule: "cart", matched: 3, injected: 1 }]);
  });

  it("is copied at construction, so a later edit does not reach the session", async () => {
    const rules: FaultRule[] = [{ name: "r", urlPattern: /\/api\/cart$/, fault: { kind: "status", status: 503 } }];
    const session = createFaultEgress(recordingUpstream(), { seed: 1, rules });
    rules[0]!.fault = { kind: "status", status: 418 };
    rules.push({ urlPattern: /.*/, fault: { kind: "abort" } });
    expect((await session.fetch(new Request(CART))).status).toBe(503);
    expect(session.stats()).toHaveLength(1);
  });
});
