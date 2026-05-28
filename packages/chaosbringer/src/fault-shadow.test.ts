import { describe, expect, it } from "vitest";
import { findFaultRuleShadows, sampleUrlFromRegex } from "./crawler.js";
import type { FaultRule } from "./types.js";

function compiled(rules: Array<{
  name?: string;
  pattern: RegExp;
  methods?: string[];
  probability?: number;
}>) {
  return rules.map((r) => {
    const rule: FaultRule = {
      urlPattern: r.pattern,
      fault: { kind: "abort" },
    };
    if (r.name !== undefined) rule.name = r.name;
    if (r.methods !== undefined) rule.methods = r.methods;
    if (r.probability !== undefined) rule.probability = r.probability;
    return {
      rule,
      pattern: r.pattern,
      methods: r.methods?.map((m) => m.toUpperCase()),
    };
  });
}

describe("sampleUrlFromRegex", () => {
  it("strips ^/$ anchors so the literal body survives", () => {
    expect(sampleUrlFromRegex(/^https:\/\/api\.example\.com\/p\//)).toBe(
      "https://api.example.com/p/",
    );
  });

  it("drops `(?...)` lookahead constructs (so negative lookahead in catch-alls doesn't poison the sample)", () => {
    // The catch-all from #129: anything not on 127.0.0.1.
    expect(sampleUrlFromRegex(/^https?:\/\/(?!127\.0\.0\.1)/)).toBe(
      "https://",
    );
  });

  it("drops quantified character classes so the sample stays URL-shaped", () => {
    // `[^/]+` is dropped entirely; `\d` becomes a single letter. The
    // important property is that no regex metachars leak into the sample
    // (so `earlier.pattern.test(sample)` doesn't accidentally double-match).
    const sample = sampleUrlFromRegex(
      /^https:\/\/api\.example\.com\/[^/]+\/v\d+\//,
    );
    expect(sample).not.toMatch(/[\[\]+*?{}|]/);
    expect(sample.startsWith("https://api.example.com/")).toBe(true);
    expect(sample.endsWith("/")).toBe(true);
  });

  it("returns an empty / metachar-only string when there's no literal content to recover", () => {
    // `[a-z]+` has no literals; the function returns "" so the caller skips
    // the shadow check rather than emitting a spurious warning.
    expect(sampleUrlFromRegex(/^[a-z]+$/)).toBe("");
    // `.*` reduces to "." — a sample no realistic URL-shaped pattern will
    // match, so no false positive in `findFaultRuleShadows`.
    expect(sampleUrlFromRegex(/.*/)).toBe(".");
  });
});

describe("findFaultRuleShadows", () => {
  it("flags the canonical catch-all-before-specific case from #129", () => {
    const rules = compiled([
      // Block-external catch-all FIRST — wrong order.
      {
        name: "block-external",
        pattern: /^https?:\/\/(?!127\.0\.0\.1)/,
      },
      {
        name: "fulfill-api",
        pattern: /^https:\/\/api\.example\.com\/p\//,
      },
    ]);

    const shadows = findFaultRuleShadows(rules);
    expect(shadows).toHaveLength(1);
    expect(shadows[0]!.earlierName).toBe("block-external");
    expect(shadows[0]!.laterName).toBe("fulfill-api");
    expect(shadows[0]!.sampleUrl).toBe("https://api.example.com/p/");
  });

  it("does not flag a specific-first / catch-all-last config", () => {
    const rules = compiled([
      {
        name: "fulfill-api",
        pattern: /^https:\/\/api\.example\.com\/p\//,
      },
      {
        name: "block-external",
        pattern: /^https?:\/\//,
      },
    ]);

    expect(findFaultRuleShadows(rules)).toEqual([]);
  });

  it("does not flag unrelated patterns", () => {
    const rules = compiled([
      { name: "block-tracking", pattern: /tracking/ },
      { name: "api-500", pattern: /^https:\/\/api\.example\.com\/users/ },
    ]);
    expect(findFaultRuleShadows(rules)).toEqual([]);
  });

  it("skips earlier rules with probability < 1 (they don't reliably shadow)", () => {
    const rules = compiled([
      {
        name: "flaky-block",
        pattern: /^https?:\/\//,
        probability: 0.3,
      },
      {
        name: "fulfill-api",
        pattern: /^https:\/\/api\.example\.com\/p\//,
      },
    ]);
    expect(findFaultRuleShadows(rules)).toEqual([]);
  });

  it("respects method filters — earlier rule narrowed to POST does not shadow GET-default later rule", () => {
    const rules = compiled([
      {
        name: "post-blocker",
        pattern: /^https:\/\//,
        methods: ["POST"],
      },
      {
        name: "any-method-api",
        pattern: /^https:\/\/api\.example\.com\/p\//,
        // no methods = all methods
      },
    ]);
    expect(findFaultRuleShadows(rules)).toEqual([]);
  });

  it("flags when earlier method-restricted rule covers every method the later rule names", () => {
    const rules = compiled([
      {
        name: "post-blocker",
        pattern: /^https:\/\//,
        methods: ["POST", "PUT"],
      },
      {
        name: "post-api",
        pattern: /^https:\/\/api\.example\.com\/p\//,
        methods: ["POST"],
      },
    ]);
    const shadows = findFaultRuleShadows(rules);
    expect(shadows).toHaveLength(1);
    expect(shadows[0]!.earlierName).toBe("post-blocker");
  });

  it("derives a name from the pattern when the rule has no `name`", () => {
    const rules = compiled([
      { pattern: /^https?:\/\// },
      { pattern: /^https:\/\/api\.example\.com\/p\// },
    ]);
    const shadows = findFaultRuleShadows(rules);
    expect(shadows).toHaveLength(1);
    expect(shadows[0]!.earlierName).toMatch(/^\//);
    expect(shadows[0]!.laterName).toMatch(/^\//);
  });

  it("returns multiple shadows when the catch-all hides several later rules", () => {
    const rules = compiled([
      { name: "block-all", pattern: /^https?:\/\// },
      { name: "api-a", pattern: /^https:\/\/a\.example\.com\// },
      { name: "api-b", pattern: /^https:\/\/b\.example\.com\// },
    ]);
    const shadows = findFaultRuleShadows(rules);
    expect(shadows).toHaveLength(2);
    expect(shadows.map((s) => s.laterName)).toEqual(["api-a", "api-b"]);
  });
});
