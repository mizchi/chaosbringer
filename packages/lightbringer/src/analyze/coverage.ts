// Coverage analysis (PERF_COV). Turns Chromium JS/CSS coverage entries into a
// per-resource used/total rollup, and the merged-range artifact used to union
// usage across scenarios (scripts/coverage.mjs). Pure: consumes plain entries.

/** Coverage of one downloaded resource (a JS chunk or a stylesheet). */
export interface CoverageFile {
  url: string;
  totalBytes: number;
  usedBytes: number;
  /** usedBytes / totalBytes as a percentage (0..100) */
  usedPct: number;
}

/** JS or CSS coverage rollup for the scenario. */
export interface CoverageReport {
  totalBytes: number;
  usedBytes: number;
  usedPct: number;
  /** per-resource, heaviest unused first (the best split / drop candidates) */
  files: CoverageFile[];
}

export interface Coverage {
  js: CoverageReport;
  css: CoverageReport;
}

// Playwright Chromium coverage entry shapes (only the fields we read).
export interface JSCoverageEntry {
  url: string;
  source?: string;
  functions: Array<{
    ranges: Array<{ startOffset: number; endOffset: number; count: number }>;
  }>;
}
export interface CSSCoverageEntry {
  url: string;
  text?: string;
  ranges: Array<{ start: number; end: number }>;
}

/** Per-resource used byte ranges (merged), kept for cross-scenario union. */
export interface CoverageArtifact {
  js: Array<{ url: string; total: number; used: Array<[number, number]> }>;
  css: Array<{ url: string; total: number; used: Array<[number, number]> }>;
}

/** Merge overlapping/adjacent byte ranges into a minimal sorted set. */
export function mergeRanges(
  ranges: Array<[number, number]>,
): Array<[number, number]> {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [[sorted[0][0], sorted[0][1]]];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    const last = out[out.length - 1];
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

const rangesLen = (r: Array<[number, number]>): number =>
  r.reduce((a, [s, e]) => a + (e - s), 0);

/**
 * V8 block coverage → used byte ranges. Ranges are nested: a byte's coverage is
 * the count of the INNERMOST range containing it (the outermost range is the whole
 * module and is count>0 whenever it merely evaluated, so a naive union of count>0
 * ranges reports ~100%). Paint outer→inner (inner overrides) and extract the runs
 * that ended up covered.
 */
export function jsUsedRanges(
  functions: JSCoverageEntry["functions"],
  total: number,
): Array<[number, number]> {
  if (!total) return [];
  const ranges: Array<{ startOffset: number; endOffset: number; count: number }> = [];
  for (const fn of functions) for (const r of fn.ranges) ranges.push(r);
  // outer first: smaller start, then larger end; inner ranges come later and override
  ranges.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  const paint = new Uint8Array(total);
  for (const r of ranges) {
    paint.fill(r.count > 0 ? 1 : 0, r.startOffset, Math.min(r.endOffset, total));
  }
  const out: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < total; i++) {
    if (paint[i] === 1) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      out.push([start, i]);
      start = -1;
    }
  }
  if (start >= 0) out.push([start, total]);
  return out;
}

/** Group by url, merge used ranges; total = source/text length (or max offset). */
function collectCoverage(
  items: Array<{ url: string; total: number; used: Array<[number, number]> }>,
): Array<{ url: string; total: number; used: Array<[number, number]> }> {
  const by = new Map<
    string,
    { total: number; used: Array<[number, number]> }
  >();
  for (const it of items) {
    if (!it.url) continue; // skip inline/anonymous
    const b = by.get(it.url) ?? { total: 0, used: [] };
    b.total = Math.max(b.total, it.total);
    b.used.push(...it.used);
    by.set(it.url, b);
  }
  return [...by.entries()].map(([url, b]) => ({
    url,
    total: b.total,
    used: mergeRanges(b.used),
  }));
}

function toCoverageReport(
  perUrl: Array<{ url: string; total: number; used: Array<[number, number]> }>,
): CoverageReport {
  let totalBytes = 0;
  let usedBytes = 0;
  const files = perUrl.map((f) => {
    const used = rangesLen(f.used);
    totalBytes += f.total;
    usedBytes += used;
    return {
      url: f.url,
      totalBytes: f.total,
      usedBytes: used,
      usedPct: f.total > 0 ? Math.round((used / f.total) * 1000) / 10 : 0,
    };
  });
  // heaviest unused first — the best split/drop candidates
  files.sort((a, b) => b.totalBytes - b.usedBytes - (a.totalBytes - a.usedBytes));
  return {
    totalBytes,
    usedBytes,
    usedPct: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0,
    files: files.slice(0, 40),
  };
}

/** Build the scenario coverage report + the range artifact (for cross-scenario union). */
export function buildCoverage(
  js: JSCoverageEntry[],
  css: CSSCoverageEntry[],
): { coverage: Coverage; artifact: CoverageArtifact } {
  const jsItems = js.map((e) => {
    let maxEnd = 0;
    for (const fn of e.functions)
      for (const r of fn.ranges) if (r.endOffset > maxEnd) maxEnd = r.endOffset;
    const total = e.source?.length ?? maxEnd;
    return { url: e.url, total, used: jsUsedRanges(e.functions, total) };
  });
  const cssItems = css.map((e) => ({
    url: e.url,
    total: e.text?.length ?? 0,
    used: e.ranges.map((r) => [r.start, r.end] as [number, number]),
  }));
  const jsPerUrl = collectCoverage(jsItems);
  const cssPerUrl = collectCoverage(cssItems);
  return {
    coverage: { js: toCoverageReport(jsPerUrl), css: toCoverageReport(cssPerUrl) },
    artifact: { js: jsPerUrl, css: cssPerUrl },
  };
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

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
}
