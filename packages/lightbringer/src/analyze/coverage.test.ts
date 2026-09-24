import { describe, expect, it } from "vitest";
import { buildCoverage, jsUsedRanges, mergeRanges } from "./coverage";

describe("mergeRanges", () => {
  it("merges overlapping and adjacent ranges", () => {
    expect(mergeRanges([[0, 5], [5, 10], [20, 25]])).toEqual([[0, 10], [20, 25]]);
  });
});

describe("jsUsedRanges", () => {
  it("treats the innermost count=0 range as uncovered, not the outer count>0", () => {
    // outer module range covered, inner function body never ran
    const fns = [
      { ranges: [{ startOffset: 0, endOffset: 100, count: 1 }] },
      { ranges: [{ startOffset: 40, endOffset: 80, count: 0 }] },
    ];
    const used = jsUsedRanges(fns, 100);
    expect(used).toEqual([[0, 40], [80, 100]]);
  });
  it("returns nothing for a zero-length module", () => {
    expect(jsUsedRanges([], 0)).toEqual([]);
  });
});

describe("buildCoverage", () => {
  it("computes used percentage per resource", () => {
    const { coverage } = buildCoverage(
      [
        {
          url: "https://x/app.js",
          source: "x".repeat(100),
          functions: [{ ranges: [{ startOffset: 0, endOffset: 100, count: 1 }, { startOffset: 50, endOffset: 100, count: 0 }] }],
        },
      ],
      [],
    );
    expect(coverage.js.files[0]?.usedPct).toBe(50);
  });
});
