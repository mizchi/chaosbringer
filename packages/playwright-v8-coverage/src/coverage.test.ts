import { describe, expect, it } from "vitest";
import {
  coverageDelta,
  coverageSignature,
  noveltyMultiplier,
  summarizeCoverage,
  targetKey,
  type CoverageScriptResult,
} from "./coverage.js";

function script(url: string, fns: Array<{ name: string; ranges: Array<[number, number, number]> }>): CoverageScriptResult {
  return {
    scriptId: `id-${url}`,
    url,
    functions: fns.map((f) => ({
      functionName: f.name,
      ranges: f.ranges.map(([startOffset, endOffset, count]) => ({ startOffset, endOffset, count })),
    })),
  };
}

describe("coverageSignature", () => {
  it("emits one fingerprint per function that ran at least once", () => {
    const sig = coverageSignature([
      script("https://app/main.js", [
        { name: "init", ranges: [[0, 100, 1]] },
        { name: "boot", ranges: [[100, 200, 0]] }, // Did not run.
        { name: "render", ranges: [[200, 300, 0], [205, 290, 7]] }, // One range fired.
      ]),
    ]);
    expect(sig.size).toBe(2);
    expect(sig.has("https://app/main.js init 0")).toBe(true);
    expect(sig.has("https://app/main.js render 200")).toBe(true);
    expect(sig.has("https://app/main.js boot 100")).toBe(false);
  });

  it("falls back to scriptId for anonymous / inline scripts (chromium reports them with empty url)", () => {
    const result: CoverageScriptResult = {
      scriptId: "42",
      url: "",
      functions: [
        { functionName: "anon", ranges: [{ startOffset: 0, endOffset: 10, count: 5 }] },
      ],
    };
    const sig = coverageSignature([result]);
    expect(sig.size).toBe(1);
    expect(sig.has("script:42 anon 0")).toBe(true);
  });

  it("uses scriptUrl + functionName + startOffset to disambiguate same-named functions", () => {
    const sig = coverageSignature([
      script("https://app/a.js", [{ name: "f", ranges: [[0, 10, 1]] }]),
      script("https://app/a.js", [{ name: "f", ranges: [[20, 30, 1]] }]),
      script("https://app/b.js", [{ name: "f", ranges: [[0, 10, 1]] }]),
    ]);
    expect(sig.size).toBe(3);
  });
});

describe("coverageDelta", () => {
  it("returns elements present in `next` but not in `prev`", () => {
    const prev = new Set(["a", "b"]);
    const next = new Set(["a", "b", "c", "d"]);
    expect([...coverageDelta(prev, next)].sort()).toEqual(["c", "d"]);
  });

  it("returns an empty set when next is a subset of prev", () => {
    const prev = new Set(["a", "b", "c"]);
    const next = new Set(["a", "b"]);
    expect(coverageDelta(prev, next).size).toBe(0);
  });

  it("works on empty inputs", () => {
    expect(coverageDelta(new Set(), new Set()).size).toBe(0);
    expect(coverageDelta(new Set(), new Set(["x"])).size).toBe(1);
  });
});

describe("noveltyMultiplier", () => {
  it("returns 1 when boost is 0", () => {
    expect(noveltyMultiplier(100, 0)).toBe(1);
  });

  it("returns 1 when score is 0 or negative", () => {
    expect(noveltyMultiplier(0, 2)).toBe(1);
    expect(noveltyMultiplier(-5, 2)).toBe(1);
  });

  it("grows logarithmically — 100 score is ~10× weight, not 100×", () => {
    // 1 + 2·log(101) ≈ 10.23 — bounded by the slow growth of natural log.
    expect(noveltyMultiplier(100, 2)).toBeLessThan(11);
    expect(noveltyMultiplier(100, 2)).toBeGreaterThan(noveltyMultiplier(10, 2));
  });

  it("monotonic in score", () => {
    const xs = [1, 2, 5, 10, 50, 100, 1000];
    let prev = 0;
    for (const x of xs) {
      const m = noveltyMultiplier(x, 2);
      expect(m).toBeGreaterThan(prev);
      prev = m;
    }
  });

  it("monotonic in boost", () => {
    expect(noveltyMultiplier(10, 1)).toBeLessThan(noveltyMultiplier(10, 2));
    expect(noveltyMultiplier(10, 2)).toBeLessThan(noveltyMultiplier(10, 4));
  });
});

describe("targetKey", () => {
  it("produces stable keys", () => {
    const k1 = targetKey("https://app/x", "button.primary");
    const k2 = targetKey("https://app/x", "button.primary");
    expect(k1).toBe(k2);
  });

  it("disambiguates same selector across URLs", () => {
    expect(targetKey("https://a", "btn")).not.toBe(targetKey("https://b", "btn"));
  });

  it("uses space as separator (so the URL part stays human-parseable)", () => {
    expect(targetKey("https://app/x", "btn")).toBe("https://app/x btn");
  });
});

describe("summarizeCoverage", () => {
  it("counts pages with non-zero deltas", () => {
    const summary = summarizeCoverage({
      globalCovered: new Set(["f1", "f2"]),
      pageDeltas: [
        { url: "/", addedCount: 2 },
        { url: "/about", addedCount: 0 },
        { url: "/items", addedCount: 1 },
      ],
      targetNovelty: new Map(),
    });
    expect(summary.totalFunctions).toBe(2);
    expect(summary.pagesWithNewCoverage).toBe(2);
    expect(summary.topNovelTargets).toEqual([]);
  });

  it("sorts top targets by score desc and respects topN", () => {
    const targetNovelty = new Map([
      [targetKey("/a", "btn1"), 5],
      [targetKey("/b", "btn2"), 10],
      [targetKey("/c", "btn3"), 1],
      [targetKey("/d", "btn4"), 8],
    ]);
    const summary = summarizeCoverage({
      globalCovered: new Set(),
      pageDeltas: [],
      targetNovelty,
      topN: 2,
    });
    expect(summary.topNovelTargets).toEqual([
      { url: "/b", selector: "btn2", score: 10 },
      { url: "/d", selector: "btn4", score: 8 },
    ]);
  });

  it("ties break deterministically by url then selector", () => {
    const targetNovelty = new Map([
      [targetKey("/b", "x"), 5],
      [targetKey("/a", "y"), 5],
      [targetKey("/a", "x"), 5],
    ]);
    const summary = summarizeCoverage({
      globalCovered: new Set(),
      pageDeltas: [],
      targetNovelty,
    });
    expect(summary.topNovelTargets.map((t) => `${t.url}|${t.selector}`)).toEqual([
      "/a|x",
      "/a|y",
      "/b|x",
    ]);
  });
});
