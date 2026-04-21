import { describe, expect, it } from "vitest";
import { validateOptions } from "./crawler.js";

function base(extra: Record<string, unknown> = {}): any {
  return { baseUrl: "http://localhost:3000", ...extra };
}

describe("validateOptions", () => {
  it("accepts a minimal valid config", () => {
    expect(() => validateOptions(base())).not.toThrow();
  });

  it("rejects a non-URL baseUrl with a named message", () => {
    expect(() => validateOptions({ baseUrl: "not-a-url" } as any)).toThrow(
      /chaosbringer: "baseUrl"/
    );
  });

  it("rejects negative maxPages", () => {
    expect(() => validateOptions(base({ maxPages: -3 }))).toThrow(/maxPages/);
  });

  it("rejects zero maxPages", () => {
    expect(() => validateOptions(base({ maxPages: 0 }))).toThrow(/maxPages/);
  });

  it("allows maxActionsPerPage of 0", () => {
    expect(() => validateOptions(base({ maxActionsPerPage: 0 }))).not.toThrow();
  });

  it("rejects negative maxActionsPerPage", () => {
    expect(() => validateOptions(base({ maxActionsPerPage: -1 }))).toThrow(/maxActionsPerPage/);
  });

  it("rejects non-integer timeout", () => {
    expect(() => validateOptions(base({ timeout: 1.5 }))).toThrow(/timeout/);
  });

  it("rejects negative seed", () => {
    expect(() => validateOptions(base({ seed: -1 }))).toThrow(/seed/);
  });

  it("rejects fault probability > 1", () => {
    expect(() =>
      validateOptions(
        base({
          faultInjection: [
            { name: "bad", urlPattern: ".*", fault: { kind: "status", status: 500 }, probability: 2 },
          ],
        })
      )
    ).toThrow(/probability/);
  });

  it("rejects fault probability < 0", () => {
    expect(() =>
      validateOptions(
        base({
          faultInjection: [
            { urlPattern: ".*", fault: { kind: "status", status: 500 }, probability: -0.1 },
          ],
        })
      )
    ).toThrow(/probability/);
  });

  it("rejects an invariant with a malformed urlPattern", () => {
    expect(() =>
      validateOptions(
        base({
          invariants: [
            {
              name: "bad-pattern",
              urlPattern: "(",
              check: () => true,
            },
          ],
        })
      )
    ).toThrow(/bad-pattern.*urlPattern/);
  });

  it("rejects a fault rule with a malformed urlPattern", () => {
    expect(() =>
      validateOptions(
        base({
          faultInjection: [{ name: "bad", urlPattern: "(", fault: { kind: "abort" } }],
        })
      )
    ).toThrow(/bad.*urlPattern/);
  });

  it("rejects an invalid excludePatterns regex", () => {
    expect(() => validateOptions(base({ excludePatterns: ["("] }))).toThrow(
      /excludePatterns/
    );
  });
});
