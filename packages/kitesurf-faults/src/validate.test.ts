import { describe, expect, it, vi } from "vitest";
import {
  createFaultEgress,
  KitesurfFaultsError,
  type FaultEgressOptions,
  type FaultRule,
} from "./index.js";

// Every configuration error has to surface from the factory, synchronously,
// before the first request: a rule that is quietly ignored on a transport
// presents as "my fault never fired", and on Kitesurf that is a whole
// workerd + engine run spent finding out.

const upstream = { fetch: vi.fn(async () => new Response("ok")) };

function rule(over: Partial<FaultRule> = {}): FaultRule {
  return { urlPattern: /\/api\/cart$/, fault: { kind: "status", status: 503 }, ...over };
}

function configError(options: unknown): KitesurfFaultsError {
  try {
    createFaultEgress(upstream, options as FaultEgressOptions);
  } catch (e) {
    expect(e).toBeInstanceOf(KitesurfFaultsError);
    const err = e as KitesurfFaultsError;
    expect(err.code).toBe("invalid-config");
    expect(err.message.startsWith("kitesurf-faults: ")).toBe(true);
    return err;
  }
  throw new Error("expected createFaultEgress to throw");
}

describe("createFaultEgress rejects invalid configuration at construction", () => {
  const invalid: Array<[string, unknown, RegExp]> = [
    ["no options", undefined, /options/],
    ["rules not an array", { seed: 1, rules: {} }, /rules/],
    ["seed -1", { seed: -1, rules: [] }, /seed/],
    ["seed 1.5", { seed: 1.5, rules: [] }, /seed/],
    ["seed 2**32", { seed: 2 ** 32, rules: [] }, /seed/],
    ["seed NaN", { seed: Number.NaN, rules: [] }, /seed/],
    ["seed undefined", { rules: [] }, /seed/],
    ["maxDelayMs -1", { seed: 1, rules: [], maxDelayMs: -1 }, /maxDelayMs/],
    ["maxDelayMs 5001", { seed: 1, rules: [], maxDelayMs: 5001 }, /maxDelayMs/],
    ["maxDelayMs Infinity", { seed: 1, rules: [], maxDelayMs: Infinity }, /maxDelayMs/],
    ["status 399", { seed: 1, rules: [rule({ fault: { kind: "status", status: 399 } })] }, /status/],
    ["status 600", { seed: 1, rules: [rule({ fault: { kind: "status", status: 600 } })] }, /status/],
    ["status 503.5", { seed: 1, rules: [rule({ fault: { kind: "status", status: 503.5 } })] }, /status/],
    [
      "status body not a string",
      { seed: 1, rules: [rule({ fault: { kind: "status", status: 503, body: 1 as unknown as string } })] },
      /body/,
    ],
    [
      "abort errorCode timedout",
      { seed: 1, rules: [rule({ fault: { kind: "abort", errorCode: "timedout" } })] },
      /errorCode/,
    ],
    ["delay ms -1", { seed: 1, rules: [rule({ fault: { kind: "delay", ms: -1 } })] }, /ms/],
    ["delay ms NaN", { seed: 1, rules: [rule({ fault: { kind: "delay", ms: Number.NaN } })] }, /ms/],
    ["delay ms over the default cap", { seed: 1, rules: [rule({ fault: { kind: "delay", ms: 5001 } })] }, /maxDelayMs/],
    [
      "delay ms over an explicit cap",
      { seed: 1, maxDelayMs: 100, rules: [rule({ fault: { kind: "delay", ms: 200 } })] },
      /maxDelayMs/,
    ],
    ["hang", { seed: 1, rules: [rule({ fault: { kind: "hang" } })] }, /hang/],
    [
      "unknown fault kind",
      { seed: 1, rules: [rule({ fault: { kind: "corrupt" } as unknown as FaultRule["fault"] })] },
      /kind/,
    ],
    ["resourceTypes [fetch]", { seed: 1, rules: [rule({ resourceTypes: ["fetch"] })] }, /resourceTypes/],
    ["resourceTypes []", { seed: 1, rules: [rule({ resourceTypes: [] })] }, /resourceTypes/],
    ["probability -0.1", { seed: 1, rules: [rule({ probability: -0.1 })] }, /probability/],
    ["probability 1.1", { seed: 1, rules: [rule({ probability: 1.1 })] }, /probability/],
    ["probability NaN", { seed: 1, rules: [rule({ probability: Number.NaN })] }, /probability/],
    [
      "probability and schedule together",
      { seed: 1, rules: [rule({ probability: 0.5, schedule: { decisions: ["inject"] } })] },
      /mutually exclusive/,
    ],
    ["empty decisions", { seed: 1, rules: [rule({ schedule: { decisions: [] } })] }, /decisions/],
    [
      "invalid afterEnd",
      { seed: 1, rules: [rule({ schedule: { decisions: ["inject"], afterEnd: "loop" as "pass" } })] },
      /afterEnd/,
    ],
    ["invalid regex string", { seed: 1, rules: [rule({ urlPattern: "([" })] }, /urlPattern/],
    ["urlPattern not a matcher", { seed: 1, rules: [rule({ urlPattern: 3 as unknown as string })] }, /urlPattern/],
    ["methods []", { seed: 1, rules: [rule({ methods: [] })] }, /methods/],
    ["methods with an empty string", { seed: 1, rules: [rule({ methods: [""] })] }, /methods/],
    ["no fault", { seed: 1, rules: [{ urlPattern: /x/ }] }, /fault/],
  ];

  it.each(invalid)("%s", (_label, options, fragment) => {
    expect(configError(options).message).toMatch(fragment);
  });

  it("names the rule by its name, or by its index when it has none", () => {
    expect(
      configError({ seed: 1, rules: [rule({ name: "cart-503", fault: { kind: "hang" } })] }).message,
    ).toContain('rule "cart-503"');
    expect(configError({ seed: 1, rules: [rule(), rule({ fault: { kind: "hang" } })] }).message).toContain(
      "rule #1",
    );
  });

  it("says why resourceTypes cannot be honoured instead of guessing a type", () => {
    expect(configError({ seed: 1, rules: [rule({ resourceTypes: [] })] }).message).toMatch(/x-kitesurf-\*/);
  });

  it("rejects an upstream without fetch", () => {
    expect(() => createFaultEgress({} as never, { seed: 1, rules: [] })).toThrow(KitesurfFaultsError);
  });
});

describe("createFaultEgress accepts the boundaries", () => {
  const valid: Array<[string, FaultEgressOptions]> = [
    ["empty rules", { seed: 1, rules: [] }],
    ["status 400", { seed: 1, rules: [rule({ fault: { kind: "status", status: 400 } })] }],
    ["status 599", { seed: 1, rules: [rule({ fault: { kind: "status", status: 599 } })] }],
    ["abort without errorCode", { seed: 1, rules: [rule({ fault: { kind: "abort" } })] }],
    ["abort errorCode failed", { seed: 1, rules: [rule({ fault: { kind: "abort", errorCode: "failed" } })] }],
    ["delay ms 0", { seed: 1, rules: [rule({ fault: { kind: "delay", ms: 0 } })] }],
    ["delay ms == default cap", { seed: 1, rules: [rule({ fault: { kind: "delay", ms: 5000 } })] }],
    ["delay ms == explicit cap", { seed: 1, maxDelayMs: 100, rules: [rule({ fault: { kind: "delay", ms: 100 } })] }],
    ["maxDelayMs 0", { seed: 1, maxDelayMs: 0, rules: [] }],
    ["maxDelayMs 5000", { seed: 1, maxDelayMs: 5000, rules: [] }],
    ["seed 0", { seed: 0, rules: [] }],
    ["seed 4294967295", { seed: 4294967295, rules: [] }],
    ["probability 0 and 1", { seed: 1, rules: [rule({ probability: 0 }), rule({ probability: 1 })] }],
    ["regex string", { seed: 1, rules: [rule({ urlPattern: "/api/cart$", methods: ["get"] })] }],
  ];

  it.each(valid)("%s", (_label, options) => {
    expect(() => createFaultEgress(upstream, options)).not.toThrow();
  });
});
