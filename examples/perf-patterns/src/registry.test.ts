import { describe, expect, it } from "vitest";
import { shardPatterns } from "./registry.js";

describe("shardPatterns", () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g"];

  it("returns everything without a spec", () => {
    expect(shardPatterns(ids, undefined)).toEqual(ids);
    expect(shardPatterns(ids, "")).toEqual(ids);
    expect(shardPatterns(ids, "  ")).toEqual(ids);
  });

  it("deals round-robin, 1-based", () => {
    expect(shardPatterns(ids, "1/3")).toEqual(["a", "d", "g"]);
    expect(shardPatterns(ids, "2/3")).toEqual(["b", "e"]);
    expect(shardPatterns(ids, " 3 / 3 ")).toEqual(["c", "f"]);
    expect(shardPatterns(ids, "1/1")).toEqual(ids);
  });

  it("covers every pattern exactly once across the shards", () => {
    for (const count of [1, 2, 3, 4, 8]) {
      const all = Array.from({ length: count }, (_, i) => shardPatterns(ids, `${i + 1}/${count}`)).flat();
      expect(all.sort()).toEqual(ids);
    }
  });

  it("rejects a malformed or out-of-range spec", () => {
    for (const bad of ["3", "0/3", "4/3", "1/0", "a/b", "-1/3"]) {
      expect(() => shardPatterns(ids, bad), bad).toThrow(/PATTERN_SHARD/);
    }
  });
});
