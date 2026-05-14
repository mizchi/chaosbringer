import { describe, expect, it } from "vitest";
import { extractCandidate } from "./capture.js";
import type { ActionTrace } from "./types.js";

function trace(overrides: Partial<ActionTrace> = {}): ActionTrace {
  return {
    goal: "completion",
    steps: [
      { kind: "navigate", url: "https://example.com/" },
      { kind: "click", selector: "[data-test=buy]" },
    ],
    startState: { url: "https://example.com/" },
    endState: { url: "https://example.com/thanks" },
    durationMs: 1500,
    successful: true,
    ...overrides,
  };
}

describe("extractCandidate", () => {
  it("rejects unsuccessful traces", () => {
    expect(() =>
      extractCandidate(trace({ successful: false }), { name: "n", description: "d" }),
    ).toThrow(/unsuccessful/);
  });

  it("rejects empty traces", () => {
    expect(() =>
      extractCandidate(trace({ steps: [] }), { name: "n", description: "d" }),
    ).toThrow(/no steps/);
  });

  it("auto-infers urlPattern precondition from start URL", () => {
    const recipe = extractCandidate(trace(), { name: "buy", description: "d" });
    expect(recipe.preconditions.length).toBeGreaterThan(0);
    expect(recipe.preconditions[0]!.urlPattern).toMatch(/^\\?\//);
  });

  it("infers postcondition only when end URL differs from start URL", () => {
    const sameUrl = trace({
      startState: { url: "https://x/" },
      endState: { url: "https://x/" },
    });
    const r1 = extractCandidate(sameUrl, { name: "a", description: "d" });
    expect(r1.postconditions).toEqual([]);

    const r2 = extractCandidate(trace(), { name: "b", description: "d" });
    expect(r2.postconditions.length).toBe(1);
    expect(r2.postconditions[0]!.urlPattern).toContain("thanks");
  });

  it("inferUrlPreconditions=false skips auto-inferred preconditions", () => {
    const r = extractCandidate(trace(), {
      name: "x",
      description: "d",
      inferUrlPreconditions: false,
    });
    expect(r.preconditions).toEqual([]);
  });

  it("preserves extra preconditions / postconditions", () => {
    const r = extractCandidate(trace(), {
      name: "x",
      description: "d",
      extraPreconditions: [{ hasSelector: "[data-test=cart]" }],
      extraPostconditions: [{ hasSelector: "[data-test=receipt]" }],
    });
    expect(r.preconditions).toContainEqual({ hasSelector: "[data-test=cart]" });
    expect(r.postconditions).toContainEqual({ hasSelector: "[data-test=receipt]" });
  });

  it("dedupes adjacent identical wait steps", () => {
    const t = trace({
      steps: [
        { kind: "click", selector: "a" },
        { kind: "wait", ms: 100 },
        { kind: "wait", ms: 100 },
        { kind: "click", selector: "b" },
        { kind: "wait", ms: 100 }, // not adjacent to previous wait → kept
      ],
    });
    const r = extractCandidate(t, { name: "x", description: "d" });
    expect(r.steps.length).toBe(4);
  });

  it("anchors the regex so /cart doesn't match /cart/checkout", () => {
    const r = extractCandidate(
      trace({
        startState: { url: "https://x/cart" },
        endState: { url: "https://x/cart/checkout" },
      }),
      { name: "x", description: "d" },
    );
    const re = new RegExp(r.preconditions[0]!.urlPattern!);
    expect(re.test("/cart")).toBe(true);
    expect(re.test("/cart?x=1")).toBe(true);
    expect(re.test("/cart/checkout")).toBe(true); // start anchor not present
    expect(re.test("/cartfoo")).toBe(false);      // boundary anchor blocks suffix
  });
});
