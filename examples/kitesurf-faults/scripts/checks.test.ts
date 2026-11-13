import { describe, expect, it } from "vitest";
import { BROKEN_OWN, cartExpect, judge, MISSING_URL_OWN } from "./checks.mjs";

// S2 and S3 pass only when the oracle rejects the run for the expected reason.
// That alone is too weak: a broken page that never saw the 503 (the rule did
// not fire) still differs from the correct page's DOM, and a run whose stats
// were lost adds a code rather than replacing one. So each expected failure
// also has to meet its own facts, the ones that show the failure happened for
// the reason the scenario names.

const brokenRun = {
  dom: { attempts: "503", result: "failed" },
  stats: [{ rule: "cart-503-once", matched: 1, injected: 1 }],
  upstream: { "/broken/": 1 },
};

describe("judge, expected failure (S2)", () => {
  const expectBroken = { code: "dom-mismatch", own: BROKEN_OWN };

  it("matches the broken page that mishandled a 503 that really was injected", () => {
    const j = judge({ ...brokenRun, expect: cartExpect("/broken/") }, expectBroken);
    expect(j.matched).toBe(true);
    expect(j.result).toMatch(/^fail:dom-mismatch/);
  });

  it("does not match when the rule never fired on the broken page", () => {
    const never = {
      dom: { attempts: "200", result: "ok:3" },
      stats: [{ rule: "cart-503-once", matched: 1, injected: 0 }],
      upstream: { "/broken/": 1, "/api/cart": 1 },
    };
    const j = judge({ ...never, expect: cartExpect("/broken/") }, expectBroken);
    // The oracle still says dom-mismatch, which is why the code alone is not enough.
    expect(j.result).toContain("dom-mismatch");
    expect(j.matched).toBe(false);
  });

  it("does not match when the run's stats were lost", () => {
    const j = judge({ ...brokenRun, stats: undefined, expect: cartExpect("/broken/") }, expectBroken);
    expect(j.result).toContain("dom-mismatch");
    expect(j.matched).toBe(false);
  });

  it("does not match when the fixture server was asked for the cart", () => {
    const j = judge({ ...brokenRun, upstream: { "/broken/": 1, "/api/cart": 1 }, expect: cartExpect("/broken/") }, expectBroken);
    expect(j.matched).toBe(false);
  });
});

describe("judge, expected failure (S3)", () => {
  const missingRun = {
    dom: { attempts: "200", result: "ok:3" },
    stats: [{ rule: "cart-503-once", matched: 0, injected: 0 }],
    upstream: { "/correct/": 1, "/api/cart": 1 },
  };
  const expectMissing = { code: "not-injected", own: MISSING_URL_OWN };

  it("matches a rule that never matched while the page loaded normally", () => {
    expect(judge({ ...missingRun, expect: cartExpect("/correct/") }, expectMissing).matched).toBe(true);
  });

  it("does not match when the page never loaded the cart", () => {
    const j = judge({ ...missingRun, dom: { attempts: null, result: "pending" }, upstream: { "/correct/": 1 }, expect: cartExpect("/correct/") }, expectMissing);
    expect(j.result).toContain("not-injected");
    expect(j.matched).toBe(false);
  });
});

describe("judge, expected pass", () => {
  it("matches only an oracle pass", () => {
    const run = { dom: { attempts: "503,200", result: "ok:3" }, stats: [{ rule: "cart-503-once", matched: 2, injected: 1 }], upstream: { "/correct/": 1, "/api/cart": 1 } };
    expect(judge({ ...run, expect: cartExpect("/correct/") }).matched).toBe(true);
    expect(judge({ ...run, stats: undefined, expect: cartExpect("/correct/") }).matched).toBe(false);
  });
});
