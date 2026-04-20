import { describe, it, expect } from "vitest";
import { createRng, randomSeed, weightedPick, randomInt } from "./random.js";

describe("createRng", () => {
  it("produces values in [0, 1)", () => {
    const rng = createRng(1);
    for (let i = 0; i < 100; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("is deterministic: same seed produces same sequence", () => {
    const a = createRng(1234);
    const b = createRng(1234);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("different seeds produce different sequences", () => {
    const a = createRng(1);
    const b = createRng(2);
    const seqA = Array.from({ length: 10 }, () => a.next());
    const seqB = Array.from({ length: 10 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it("exposes the seed it was created with", () => {
    expect(createRng(42).seed).toBe(42);
  });
});

describe("randomSeed", () => {
  it("returns a non-negative 32-bit integer", () => {
    for (let i = 0; i < 20; i++) {
      const s = randomSeed();
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("weightedPick", () => {
  it("only returns items with non-zero weight", () => {
    const rng = createRng(1);
    const items = [
      { id: "a", w: 0 },
      { id: "b", w: 1 },
      { id: "c", w: 0 },
    ];
    for (let i = 0; i < 50; i++) {
      const picked = weightedPick(items, (x) => x.w, rng);
      expect(picked.id).toBe("b");
    }
  });

  it("approximates the weight distribution over many samples", () => {
    const rng = createRng(7);
    const items = [
      { id: "a", w: 1 },
      { id: "b", w: 3 },
    ];
    const counts = { a: 0, b: 0 };
    const n = 2000;
    for (let i = 0; i < n; i++) {
      const picked = weightedPick(items, (x) => x.w, rng);
      counts[picked.id as "a" | "b"]++;
    }
    // Expected ratio a:b ≈ 1:3 (±5% slack)
    expect(counts.b / n).toBeGreaterThan(0.7);
    expect(counts.b / n).toBeLessThan(0.8);
  });

  it("throws when items is empty", () => {
    const rng = createRng(1);
    expect(() => weightedPick([], () => 1, rng)).toThrow(/empty/);
  });

  it("falls back to last item when all weights are zero", () => {
    const rng = createRng(1);
    const items = ["a", "b", "c"];
    expect(weightedPick(items, () => 0, rng)).toBe("c");
  });
});

describe("randomInt", () => {
  it("returns integers in [0, max)", () => {
    const rng = createRng(1);
    for (let i = 0; i < 100; i++) {
      const v = randomInt(rng, 10);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(10);
    }
  });

  it("is deterministic", () => {
    const a = createRng(1);
    const b = createRng(1);
    const seqA = Array.from({ length: 20 }, () => randomInt(a, 1000));
    const seqB = Array.from({ length: 20 }, () => randomInt(b, 1000));
    expect(seqA).toEqual(seqB);
  });
});
