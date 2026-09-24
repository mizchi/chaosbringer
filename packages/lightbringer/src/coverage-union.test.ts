import { describe, expect, it } from "vitest";
import { formatCoverageUnion, mergeCoverageArtifacts, unionCoverage } from "./coverage-union";

describe("unionCoverage", () => {
  it("counts a byte used if any run used it, heaviest unused first", () => {
    const u = unionCoverage([
      {
        js: [
          { url: "http://x/a.js", total: 10_000, used: [[0, 1000]] },
          { url: "http://x/dead.js", total: 8_000, used: [] },
        ],
        css: [],
      },
      { js: [{ url: "http://x/a.js", total: 10_000, used: [[500, 2000]] }] },
    ]);
    expect(u.js.rows).toEqual([
      { url: "http://x/a.js", total: 10_000, used: 2000, pct: 20 },
      { url: "http://x/dead.js", total: 8_000, used: 0, pct: 0 },
    ]);
    expect(u.js).toMatchObject({ total: 18_000, used: 2000, pct: 11.1 });
    expect(u.css).toEqual({ rows: [], total: 0, used: 0, pct: 0 });

    const lines = formatCoverageUnion(u, { runs: 2 });
    expect(lines).toEqual([
      "\n[coverage] union across 2 scenario run(s)",
      "\n  JS  11.1% used overall  (2/17.6KB, 15.6KB never used)",
      "    never used by any scenario (dead-code / over-shipping):",
      "           7.8KB  /dead.js",
      "    under 30% used (split too coarse / lazy-load candidate):",
      "         20% used      7.8KB unused  /a.js",
      "",
    ]);
  });

  it("reports a reasonable split when nothing is flagged", () => {
    const u = unionCoverage([{ css: [{ url: "http://x/s.css", total: 6000, used: [[0, 6000]] }] }]);
    expect(formatCoverageUnion(u, { runs: 1, minPct: 50 })).toContain(
      "    all chunks >= 50% used — split looks reasonable.",
    );
  });
});

describe("mergeCoverageArtifacts", () => {
  it("folds artifacts one at a time into the same union as all at once", () => {
    const a = {
      js: [{ url: "http://x/a.js", total: 10_000, used: [[0, 1000]] as Array<[number, number]> }],
      css: [],
    };
    const b = {
      js: [
        { url: "http://x/a.js", total: 12_000, used: [[500, 2000]] as Array<[number, number]> },
        { url: "http://x/b.js", total: 3000, used: [] },
      ],
    };
    const c = { css: [{ url: "http://x/s.css", total: 6000, used: [[0, 10]] as Array<[number, number]> }] };
    const folded = mergeCoverageArtifacts(mergeCoverageArtifacts(a, b), c);
    expect(folded.js[0]).toEqual({ url: "http://x/a.js", total: 12_000, used: [[0, 2000]] });
    expect(unionCoverage([folded])).toEqual(unionCoverage([a, b, c]));
    // inputs untouched
    expect(a.js[0]!.used).toEqual([[0, 1000]]);
  });
});
