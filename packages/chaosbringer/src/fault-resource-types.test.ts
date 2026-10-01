import { describe, expect, it } from "vitest";
import { compileFaultRules, pickFaultRule } from "./fault-router.js";
import { findFaultRuleShadows } from "./fault-shadow.js";
import { faults } from "./faults.js";
import { validateOptions } from "./validate.js";

/**
 * `FaultRule.resourceTypes`: fault what the page's code requests without
 * touching a document that shares its URL. Next.js App Router fetches a
 * route's data from the route's own URL (`/docs?_rsc=…`), so a URL pattern
 * alone cannot tell the data request from the page navigation.
 */
describe("FaultRule.resourceTypes", () => {
  const rng = { next: () => 0 };

  it("matches only the listed types, case-insensitively, and nothing of unknown type", () => {
    const rules = compileFaultRules([faults.abort({ urlPattern: /\/docs/, resourceTypes: ["Fetch", "xhr"] })]);
    expect(pickFaultRule(rules, "https://x.test/docs?_rsc=1", "GET", rng, "fetch")).not.toBeNull();
    expect(pickFaultRule(rules, "https://x.test/docs", "GET", rng, "document")).toBeNull();
    expect(pickFaultRule(rules, "https://x.test/docs", "GET", rng)).toBeNull();
    // Only the request that matched counts.
    expect([rules[0]!.matched, rules[0]!.injected]).toEqual([1, 1]);
  });

  it("leaves a rule without it matching every type, as before", () => {
    const rules = compileFaultRules([faults.abort({ urlPattern: /\/docs/ })]);
    expect(pickFaultRule(rules, "https://x.test/docs", "GET", rng, "document")).not.toBeNull();
    expect(pickFaultRule(rules, "https://x.test/docs", "GET", rng)).not.toBeNull();
  });

  it("is validated", () => {
    const base = { baseUrl: "https://x.test" };
    expect(() =>
      validateOptions({ ...base, faultInjection: [{ urlPattern: "/a", fault: { kind: "abort" }, resourceTypes: [] }] }),
    ).toThrow(/resourceTypes must be a non-empty array/);
    expect(() =>
      validateOptions({ ...base, faultInjection: [faults.abort({ urlPattern: "/a", resourceTypes: ["fetch"] })] }),
    ).not.toThrow();
  });

  it("does not count a type-limited rule as shadowing one that matches more types", () => {
    const shadows = (earlier: string[] | undefined, later: string[] | undefined) =>
      findFaultRuleShadows(
        compileFaultRules([
          faults.abort({ urlPattern: /\/api\//, ...(earlier ? { resourceTypes: earlier } : {}) }),
          faults.status(500, { urlPattern: /\/api\/x/, ...(later ? { resourceTypes: later } : {}) }),
        ]),
      ).length;
    expect(shadows(["fetch"], undefined)).toBe(0);
    expect(shadows(["fetch"], ["fetch", "xhr"])).toBe(0);
    expect(shadows(["fetch", "xhr"], ["fetch"])).toBe(1);
    expect(shadows(undefined, ["fetch"])).toBe(1);
  });
});
