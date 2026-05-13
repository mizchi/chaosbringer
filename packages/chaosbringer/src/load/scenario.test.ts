import { describe, expect, it } from "vitest";
import { defineScenario, pickThinkTimeMs } from "./scenario.js";

describe("defineScenario", () => {
  it("returns a Scenario with the provided fields", () => {
    const s = defineScenario({
      name: "checkout",
      steps: [
        { name: "open", run: async () => {} },
        { name: "buy", run: async () => {} },
      ],
    });
    expect(s.name).toBe("checkout");
    expect(s.steps.length).toBe(2);
  });

  it("throws on empty steps", () => {
    expect(() => defineScenario({ name: "x", steps: [] })).toThrow(/steps is empty/);
  });

  it("throws on duplicate step names", () => {
    expect(() =>
      defineScenario({
        name: "x",
        steps: [
          { name: "a", run: async () => {} },
          { name: "a", run: async () => {} },
        ],
      }),
    ).toThrow(/duplicate step name/);
  });
});

describe("pickThinkTimeMs", () => {
  it("returns 0 when distribution=none", () => {
    expect(pickThinkTimeMs({ distribution: "none" })).toBe(0);
  });

  it("returns min when min==max", () => {
    expect(pickThinkTimeMs({ minMs: 500, maxMs: 500 })).toBe(500);
  });

  it("uniform output stays in [min,max]", () => {
    for (let i = 0; i < 50; i++) {
      const v = pickThinkTimeMs({ minMs: 100, maxMs: 200 });
      expect(v).toBeGreaterThanOrEqual(100);
      expect(v).toBeLessThanOrEqual(200);
    }
  });

  it("gaussian output stays clamped to [min,max]", () => {
    for (let i = 0; i < 200; i++) {
      const v = pickThinkTimeMs({ minMs: 50, maxMs: 150, distribution: "gaussian" });
      expect(v).toBeGreaterThanOrEqual(50);
      expect(v).toBeLessThanOrEqual(150);
    }
  });

  it("override chain: later arguments win", () => {
    // Last argument's minMs overrides earlier ones.
    const v = pickThinkTimeMs(
      { minMs: 5000, maxMs: 5000 },   // default
      { minMs: 100, maxMs: 100 },     // step (more specific, wins)
    );
    expect(v).toBe(100);
  });
});
