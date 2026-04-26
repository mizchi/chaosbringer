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

  it("accepts a RegExp literal for fault urlPattern", () => {
    expect(() =>
      validateOptions(
        base({
          faultInjection: [{ name: "r", urlPattern: /\/api\//, fault: { kind: "abort" } }],
        })
      )
    ).not.toThrow();
  });

  it("accepts a RegExp literal for invariant urlPattern", () => {
    expect(() =>
      validateOptions(
        base({
          invariants: [{ name: "r", urlPattern: /home/, check: () => true }],
        })
      )
    ).not.toThrow();
  });

  it("accepts a storageState path string", () => {
    expect(() => validateOptions(base({ storageState: "./auth.json" }))).not.toThrow();
  });

  it("rejects an empty storageState", () => {
    expect(() => validateOptions(base({ storageState: "" }))).toThrow(/storageState/);
  });

  it("rejects a non-string storageState", () => {
    expect(() => validateOptions(base({ storageState: 42 as unknown as string }))).toThrow(
      /storageState/
    );
  });

  it("accepts a well-formed performanceBudget", () => {
    expect(() =>
      validateOptions(base({ performanceBudget: { ttfb: 200, fcp: 1800, lcp: 2500 } }))
    ).not.toThrow();
  });

  it("rejects unknown keys in performanceBudget", () => {
    expect(() =>
      validateOptions(base({ performanceBudget: { wat: 100 } as any }))
    ).toThrow(/performanceBudget\.wat/);
  });

  it("rejects non-positive performanceBudget values", () => {
    expect(() =>
      validateOptions(base({ performanceBudget: { ttfb: 0 } }))
    ).toThrow(/performanceBudget\.ttfb/);
    expect(() =>
      validateOptions(base({ performanceBudget: { ttfb: -1 } }))
    ).toThrow(/performanceBudget\.ttfb/);
  });

  it("rejects non-object performanceBudget", () => {
    expect(() =>
      validateOptions(base({ performanceBudget: 500 as any }))
    ).toThrow(/performanceBudget/);
  });

  it("rejects an empty traceOut path", () => {
    expect(() => validateOptions(base({ traceOut: "" }))).toThrow(/traceOut/);
  });

  it("rejects an empty traceReplay path", () => {
    expect(() => validateOptions(base({ traceReplay: "" }))).toThrow(/traceReplay/);
  });

  it("accepts a known Playwright device name", () => {
    expect(() => validateOptions(base({ device: "iPhone 14" }))).not.toThrow();
  });

  it("rejects an unknown Playwright device name", () => {
    expect(() => validateOptions(base({ device: "NotAPhone 42" }))).toThrow(/device/);
  });

  it("rejects an empty device name", () => {
    expect(() => validateOptions(base({ device: "" }))).toThrow(/device/);
  });

  it("accepts a known network profile", () => {
    expect(() => validateOptions(base({ network: "slow-3g" }))).not.toThrow();
  });

  it("rejects an unknown network profile", () => {
    expect(() => validateOptions(base({ network: "turbo" as any }))).toThrow(/network/);
  });

  it("accepts a seedFromSitemap path", () => {
    expect(() => validateOptions(base({ seedFromSitemap: "http://x/sitemap.xml" }))).not.toThrow();
  });

  it("rejects an empty seedFromSitemap", () => {
    expect(() => validateOptions(base({ seedFromSitemap: "" }))).toThrow(/seedFromSitemap/);
  });

  it("accepts a valid shard pair", () => {
    expect(() => validateOptions(base({ shardIndex: 0, shardCount: 1 }))).not.toThrow();
    expect(() => validateOptions(base({ shardIndex: 3, shardCount: 4 }))).not.toThrow();
  });

  it("rejects shardIndex without shardCount", () => {
    expect(() => validateOptions(base({ shardIndex: 0 }))).toThrow(/shardIndex.*shardCount/);
  });

  it("rejects shardCount without shardIndex", () => {
    expect(() => validateOptions(base({ shardCount: 2 }))).toThrow(/shardIndex.*shardCount/);
  });

  it("rejects a negative shardIndex", () => {
    expect(() => validateOptions(base({ shardIndex: -1, shardCount: 2 }))).toThrow(/shardIndex/);
  });

  it("rejects an out-of-range shardIndex", () => {
    expect(() => validateOptions(base({ shardIndex: 4, shardCount: 4 }))).toThrow(/shardIndex/);
  });

  it("rejects shardCount < 1", () => {
    expect(() => validateOptions(base({ shardIndex: 0, shardCount: 0 }))).toThrow(/shardCount/);
  });

  it("accepts a valid failureArtifacts config", () => {
    expect(() => validateOptions(base({ failureArtifacts: { dir: "./failures" } }))).not.toThrow();
    expect(() =>
      validateOptions(base({ failureArtifacts: { dir: "./failures", maxArtifacts: 10 } }))
    ).not.toThrow();
  });

  it("rejects failureArtifacts without a dir", () => {
    expect(() =>
      validateOptions(base({ failureArtifacts: {} as unknown as { dir: string } }))
    ).toThrow(/failureArtifacts.dir/);
  });

  it("rejects an empty failureArtifacts.dir", () => {
    expect(() =>
      validateOptions(base({ failureArtifacts: { dir: "" } }))
    ).toThrow(/failureArtifacts.dir/);
  });

  it("rejects a negative maxArtifacts", () => {
    expect(() =>
      validateOptions(base({ failureArtifacts: { dir: "./x", maxArtifacts: -1 } }))
    ).toThrow(/maxArtifacts/);
  });
});
