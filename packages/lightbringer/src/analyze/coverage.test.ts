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

// B4: Chromium reports every inline <script> (and <style>) of a document under
// the document's URL, each with its own source and offsets starting at 0.
// Grouping them by URL alone laid their ranges over each other, so a page with
// one fully-run inline script and one never-run one read ~100% used.
describe("buildCoverage: several inline scripts on one page", () => {
  const page = "http://x/page";
  const a = "a".repeat(689);
  const b = "b".repeat(673);
  const ran = (len: number) => [{ ranges: [{ startOffset: 0, endOffset: len, count: 1 }] }];
  const notRun = (len: number) => [
    { ranges: [{ startOffset: 0, endOffset: len, count: 1 }] },
    { ranges: [{ startOffset: 1, endOffset: len, count: 0 }] },
  ];

  it("keeps each inline script its own entry, so usage is not overstated", () => {
    const { coverage, artifact } = buildCoverage(
      [
        { url: page, source: a, functions: ran(a.length) },
        { url: page, source: b, functions: notRun(b.length) },
      ],
      [],
    );
    expect(coverage.js.totalBytes).toBe(a.length + b.length);
    expect(coverage.js.usedBytes).toBe(a.length + 1);
    // the same code as two external files reads 690/1362 = 50.7% (evaluation E5)
    expect(coverage.js.usedPct).toBe(50.7);
    expect(artifact.js.map((f) => f.url).sort()).toEqual([`${page}#inline-1`, `${page}#inline-2`]);
  });

  it("still unions one script seen in several documents (same url, same source)", () => {
    const { coverage } = buildCoverage(
      [
        { url: "http://x/app.js", source: a, functions: notRun(a.length) },
        { url: "http://x/app.js", source: a, functions: ran(a.length) },
      ],
      [],
    );
    expect(coverage.js.files).toEqual([
      { url: "http://x/app.js", totalBytes: a.length, usedBytes: a.length, usedPct: 100 },
    ]);
  });

  it("gives a page's inline scripts the same keys on every visit (reload in one collection too)", () => {
    const visit = [
      { url: page, source: a, functions: ran(a.length) },
      { url: page, source: b, functions: notRun(b.length) },
    ];
    const { artifact } = buildCoverage([...visit, ...visit], []);
    expect(artifact.js.map((f) => f.url)).toEqual([`${page}#inline-1`, `${page}#inline-2`]);
    expect(buildCoverage(visit, []).artifact.js.map((f) => f.url)).toEqual([
      `${page}#inline-1`,
      `${page}#inline-2`,
    ]);
  });

  it("keeps several inline <style> blocks apart too", () => {
    const { coverage } = buildCoverage(
      [],
      [
        { url: page, text: ".a{color:red}", ranges: [{ start: 0, end: 13 }] },
        { url: page, text: ".b{color:blue}.c{}", ranges: [] },
      ],
    );
    expect(coverage.css.totalBytes).toBe(13 + 18);
    expect(coverage.css.usedBytes).toBe(13);
  });
});
