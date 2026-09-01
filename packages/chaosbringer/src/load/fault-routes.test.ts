import { describe, expect, it } from "vitest";
import {
  compileLoadFaultRules,
  faultFiringsFrom,
  faultStatsFrom,
  installFaultRoutes,
} from "./fault-routes.js";

describe("compileLoadFaultRules", () => {
  it("returns [] for undefined / empty input", () => {
    expect(compileLoadFaultRules(undefined)).toEqual([]);
    expect(compileLoadFaultRules([])).toEqual([]);
  });

  it("compiles a string urlPattern into RegExp", () => {
    const compiled = compileLoadFaultRules([
      {
        urlPattern: "/api/users",
        fault: { kind: "status", status: 500 },
      },
    ]);
    expect(compiled.length).toBe(1);
    expect(compiled[0]!.pattern.test("https://x/api/users/1")).toBe(true);
  });

  it("normalises method list to uppercase", () => {
    const compiled = compileLoadFaultRules([
      {
        urlPattern: ".*",
        methods: ["post", "Put"],
        fault: { kind: "abort" },
      },
    ]);
    expect(compiled[0]!.methods).toEqual(["POST", "PUT"]);
  });

  it("skips invalid regex strings silently", () => {
    const compiled = compileLoadFaultRules([
      // unterminated character class
      { urlPattern: "[", fault: { kind: "abort" } },
      { urlPattern: ".*", fault: { kind: "abort" } },
    ]);
    expect(compiled.length).toBe(1);
  });

  it("faultFiringsFrom returns timestamps per rule (including empty rules)", () => {
    const compiled = compileLoadFaultRules([
      { name: "fires", urlPattern: ".*", fault: { kind: "abort" } },
      { name: "quiet", urlPattern: ".*", fault: { kind: "abort" } },
    ]);
    compiled[0]!.firings.push(1000, 1500, 2000);
    const firings = faultFiringsFrom(compiled);
    expect(firings.fires).toEqual([1000, 1500, 2000]);
    expect(firings.quiet).toEqual([]);
  });

  it("faultFiringsFrom auto-derives rule name when missing", () => {
    const compiled = compileLoadFaultRules([
      { urlPattern: ".*", fault: { kind: "abort" } },
    ]);
    compiled[0]!.firings.push(123);
    const firings = faultFiringsFrom(compiled);
    expect(firings["fault-0"]).toEqual([123]);
  });

  it("faultStatsFrom reports per-rule counters", () => {
    const compiled = compileLoadFaultRules([
      {
        name: "api-500",
        urlPattern: ".*",
        fault: { kind: "status", status: 500 },
      },
    ]);
    compiled[0]!.matched = 5;
    compiled[0]!.injected = 3;
    expect(faultStatsFrom(compiled)).toEqual([{ rule: "api-500", matched: 5, injected: 3 }]);
  });
});

describe("compileLoadFaultRules validates the firing policy", () => {
  it("refuses a rule that sets both probability and schedule", () => {
    // The other four layers throw on this; the load path used to let the
    // schedule silently win, so a config that is ambiguous everywhere else
    // was quietly reinterpreted here.
    expect(() =>
      compileLoadFaultRules([
        {
          name: "both",
          urlPattern: /\/api\/x/,
          fault: { kind: "abort" },
          probability: 0.5,
          schedule: { decisions: ["inject"] },
        },
      ]),
    ).toThrow(/mutually exclusive/);
  });

  it("names the offending rule so the error is actionable", () => {
    expect(() =>
      compileLoadFaultRules([
        {
          name: "empty-table",
          urlPattern: /\/api\/x/,
          fault: { kind: "abort" },
          schedule: { decisions: [] },
        },
      ]),
    ).toThrow(/empty-table/);
  });
});

describe("the load path shares the crawler's fault decision", () => {
  /** Minimal context/route doubles: enough to drive the installed handler. */
  function fakeContext() {
    let handler: ((route: unknown, request: unknown) => Promise<void>) | null = null;
    const served: string[] = [];
    const context = {
      route: async (_pattern: string, h: (route: unknown, request: unknown) => Promise<void>) => {
        handler = h;
      },
    } as never;
    const send = async (url: string, method = "GET") => {
      const route = {
        fulfill: async () => void served.push("fulfilled"),
        abort: async () => void served.push("aborted"),
        fallback: async () => void served.push("fallback"),
      };
      await handler?.(route, { url: () => url, method: () => method });
    };
    return { context, send, served };
  }

  it("advances a scheduled rule that lost the race, and records it as suppressed", async () => {
    // Single-pass, `second` was never consulted on the first request, so its
    // own `decisions[1]` landed on the wrong call and its inject never fired.
    const compiled = compileLoadFaultRules([
      {
        name: "first",
        urlPattern: /\/api\/x/,
        fault: { kind: "abort" },
        schedule: { decisions: ["inject", "pass"] },
      },
      {
        name: "second",
        urlPattern: /\/api\/x/,
        fault: { kind: "status", status: 503 },
        schedule: { decisions: ["inject", "inject"] },
      },
    ]);
    const { context, send, served } = fakeContext();
    await installFaultRoutes(context, compiled);
    await send("http://x/api/x");
    await send("http://x/api/x");

    expect(faultStatsFrom(compiled)).toEqual([
      { rule: "first", matched: 2, injected: 1 },
      // Occurrence advanced both times; it lost the first and won the second.
      { rule: "second", matched: 2, injected: 1, suppressed: 1 },
    ]);
    expect(served).toEqual(["aborted", "fulfilled"]);
  });

  it("falls through when no rule claims the request", async () => {
    const compiled = compileLoadFaultRules([
      { name: "only", urlPattern: /\/api\/y/, fault: { kind: "abort" } },
    ]);
    const { context, send, served } = fakeContext();
    await installFaultRoutes(context, compiled);
    await send("http://x/api/x");
    expect(served).toEqual(["fallback"]);
    expect(faultStatsFrom(compiled)).toEqual([{ rule: "only", matched: 0, injected: 0 }]);
  });

  it("timestamps only the rule that acted", async () => {
    const compiled = compileLoadFaultRules([
      {
        name: "winner",
        urlPattern: /\/api\/x/,
        fault: { kind: "abort" },
        schedule: { decisions: ["inject"] },
      },
      {
        name: "loser",
        urlPattern: /\/api\/x/,
        fault: { kind: "abort" },
        schedule: { decisions: ["inject"] },
      },
    ]);
    const { context, send } = fakeContext();
    await installFaultRoutes(context, compiled);
    await send("http://x/api/x");
    expect(compiled[0]!.firings).toHaveLength(1);
    expect(compiled[1]!.firings).toHaveLength(0);
  });
});
