import { describe, expect, it } from "vitest";
import { evaluate, type OracleExpect } from "./oracle.js";

// The oracle the issue's first example asks for: the page recovered, the
// fault was actually injected, and the real server saw exactly one call.
const cartExpect: OracleExpect = {
  dom: { attempts: "503,200", result: "ok:3" },
  stats: [{ rule: "cart-503-once", matched: 2, injected: 1 }],
  upstream: { "/api/cart": 1, "/correct/": 1 },
};

// Distinct codes: one reason is reported per mismatching element or path.
const codes = (r: ReturnType<typeof evaluate>) => [...new Set(r.reasons.map((x) => x.code))].sort();

describe("evaluate", () => {
  it("passes when DOM, stats and upstream counts all agree", () => {
    const r = evaluate({
      dom: { attempts: "503,200", result: "ok:3" },
      stats: [{ rule: "cart-503-once", matched: 2, injected: 1 }],
      upstream: { "/api/cart": 1, "/correct/": 1, "/favicon.ico": 4 },
      expect: cartExpect,
    });
    expect(r).toEqual({ ok: true, reasons: [] });
  });

  it("fails with dom-mismatch when a page did not recover (the broken fixture)", () => {
    const r = evaluate({
      dom: { attempts: "503", result: "failed" },
      stats: [{ rule: "cart-503-once", matched: 1, injected: 1 }],
      upstream: { "/broken/": 1 },
      expect: { ...cartExpect, upstream: { "/api/cart": 1 } },
    });
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(["dom-mismatch", "stats-mismatch", "upstream-count-mismatch"]);
    expect(r.reasons.filter((x) => x.code === "dom-mismatch").map((x) => x.detail)).toEqual([
      'attempts: expected "503,200", got "503"',
      'result: expected "ok:3", got "failed"',
    ]);
  });

  it("reports not-injected when the page looks fine but no fault fired", () => {
    // A rule whose URL never matches: the page shows ok:3 on its first try,
    // which a DOM-only check would call a pass.
    const r = evaluate({
      dom: { attempts: "200", result: "ok:3" },
      stats: [{ rule: "cart-503-once", matched: 0, injected: 0 }],
      upstream: { "/api/cart": 1, "/correct/": 1 },
      expect: cartExpect,
    });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("not-injected");
  });

  it("reports not-injected even when only the injected count is zero", () => {
    const r = evaluate({
      dom: { attempts: "503,200", result: "ok:3" },
      stats: [{ rule: "cart-503-once", matched: 2, injected: 0 }],
      upstream: { "/api/cart": 1, "/correct/": 1 },
      expect: cartExpect,
    });
    expect(codes(r)).toContain("not-injected");
  });

  it("fails with stats-missing when the stats could not be collected", () => {
    const r = evaluate({ dom: { attempts: "503,200", result: "ok:3" }, stats: undefined, upstream: undefined, expect: cartExpect });
    expect(r.ok).toBe(false);
    expect(codes(r)).toEqual(["stats-missing"]);
  });

  it("fails with stats-missing when an expected rule is absent from the stats", () => {
    const r = evaluate({
      dom: { attempts: "503,200", result: "ok:3" },
      stats: [{ rule: "some-other-rule", matched: 2, injected: 1 }],
      upstream: { "/api/cart": 1, "/correct/": 1 },
      expect: cartExpect,
    });
    expect(codes(r)).toContain("stats-missing");
  });

  it("fails with upstream-count-mismatch when the real server saw a retry twice", () => {
    const r = evaluate({
      dom: { attempts: "503,200", result: "ok:3" },
      stats: [{ rule: "cart-503-once", matched: 2, injected: 1 }],
      upstream: { "/api/cart": 2, "/correct/": 1 },
      expect: cartExpect,
    });
    expect(codes(r)).toEqual(["upstream-count-mismatch"]);
    expect(r.reasons[0]?.detail).toBe("/api/cart: expected 1, got 2");
  });

  it("treats a path the server never saw as 0, not as missing", () => {
    const r = evaluate({
      dom: { attempts: "503,200", result: "ok:3" },
      stats: [{ rule: "cart-503-once", matched: 2, injected: 1 }],
      upstream: { "/correct/": 1 },
      expect: { ...cartExpect, upstream: { "/api/cart": 0, "/correct/": 1 } },
    });
    expect(r.ok).toBe(true);
  });

  it("fails with dom-mismatch when an expected element is missing", () => {
    const r = evaluate({
      dom: { attempts: null, result: "ok:3" },
      stats: [{ rule: "cart-503-once", matched: 2, injected: 1 }],
      upstream: { "/api/cart": 1, "/correct/": 1 },
      expect: cartExpect,
    });
    expect(codes(r)).toEqual(["dom-mismatch"]);
  });

  it("compares suppressed only when the expectation names it", () => {
    const base = {
      dom: { attempts: "503,200", result: "ok:3" },
      upstream: { "/api/cart": 1, "/correct/": 1 },
    };
    expect(evaluate({ ...base, stats: [{ rule: "cart-503-once", matched: 2, injected: 1, suppressed: 1 }], expect: cartExpect }).ok).toBe(true);
    const strict = { ...cartExpect, stats: [{ rule: "cart-503-once", matched: 2, injected: 1, suppressed: 0 }] };
    expect(codes(evaluate({ ...base, stats: [{ rule: "cart-503-once", matched: 2, injected: 1, suppressed: 1 }], expect: strict }))).toEqual([
      "stats-mismatch",
    ]);
  });
});
