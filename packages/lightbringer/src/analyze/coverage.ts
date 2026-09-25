// Coverage analysis (PERF_COV). Turns Chromium JS/CSS coverage entries into a
// per-resource used/total rollup, and the merged-range artifact used to union
// usage across scenarios (scripts/coverage.mjs). Pure: consumes plain entries.

/** Coverage of one downloaded resource (a JS chunk or a stylesheet). */
export interface CoverageFile {
  /**
   * The resource's URL; for a page with several inline <script>/<style> blocks
   * of different content, `<page url>#inline-<n>` per block (see buildCoverage).
   */
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

// Internal helpers shared with coverage-union.ts — exported from this module
// only, not from analyze/index.ts or core.ts.

/** One per-resource entry of a CoverageArtifact. */
export type CoverageRangeItem = CoverageArtifact["js"][number];

/** Total bytes covered by a set of (merged, non-overlapping) ranges. */
export const rangesLen = (r: Array<[number, number]>): number =>
  r.reduce((a, [s, e]) => a + (e - s), 0);

/** used / total as a percentage with one decimal; 0 for an empty total. */
export const pctOf = (used: number, total: number): number =>
  total > 0 ? Math.round((used / total) * 1000) / 10 : 0;

/**
 * Group by url (Map insertion order), keeping the largest total any item saw
 * and the union of their used ranges (merged). `skipEmptyUrl` drops
 * inline/anonymous entries, which have no url to attribute bytes to.
 */
export function groupRangesByUrl(
  items: Iterable<CoverageRangeItem>,
  { skipEmptyUrl }: { skipEmptyUrl: boolean },
): CoverageRangeItem[] {
  const by = new Map<string, { total: number; used: Array<[number, number]> }>();
  for (const it of items) {
    if (skipEmptyUrl && !it.url) continue;
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
      usedPct: pctOf(used, f.total),
    };
  });
  // heaviest unused first — the best split/drop candidates
  files.sort((a, b) => b.totalBytes - b.usedBytes - (a.totalBytes - a.usedBytes));
  return {
    totalBytes,
    usedBytes,
    usedPct: pctOf(usedBytes, totalBytes),
    files: files.slice(0, 40),
  };
}

/**
 * The key each entry is grouped under. Chromium reports every inline <script>
 * (and <style>) block under its document's URL, each with its own source and
 * offsets starting at 0, so grouping by URL alone laid the blocks' ranges over
 * each other and one fully-run block made the whole page read ~100% used.
 * Entries that share a URL but differ in content are therefore told apart as
 * `<url>#inline-<n>`, n counting the distinct contents in the order Chromium
 * reported them (document order). Entries with the same content keep one key,
 * so a script seen in several documents of one collection (a reload, the
 * same external file) is still unioned; a URL with one content (every
 * external file) keeps the bare URL as before. The numbering depends only on
 * the page's own blocks, so the same page gets the same keys on every visit
 * and cross-scenario / cross-page unions line up.
 *
 * Known limit: an entry does not say which document it came from (Playwright
 * gives url, scriptId, source, functions), so blocks cannot be numbered per
 * document. A script whose content differs per response (a CSRF token in an
 * inline block, a generated external file) loaded twice in one collection is
 * therefore split into one `#inline-<n>` key per response, bytes counted
 * each time. Numbering by occurrence instead would re-merge a page's distinct
 * blocks (B4) and still not know where one document ends; documented in the
 * README rather than guessed at.
 */
function distinctContentKeys(items: Array<{ url: string; content: string | undefined }>): string[] {
  const contents = new Map<string, Array<string | undefined>>();
  for (const { url, content } of items) {
    const seen = contents.get(url) ?? [];
    if (!seen.includes(content)) seen.push(content);
    contents.set(url, seen);
  }
  return items.map(({ url, content }) => {
    const seen = contents.get(url)!;
    // an empty url is dropped later (skipEmptyUrl); nothing to number
    if (!url || seen.length < 2) return url;
    return `${url}#inline-${seen.indexOf(content) + 1}`;
  });
}

/** Build the scenario coverage report + the range artifact (for cross-scenario union). */
export function buildCoverage(
  js: JSCoverageEntry[],
  css: CSSCoverageEntry[],
): { coverage: Coverage; artifact: CoverageArtifact } {
  const jsKeys = distinctContentKeys(js.map((e) => ({ url: e.url, content: e.source })));
  const jsItems = js.map((e, i) => {
    let maxEnd = 0;
    for (const fn of e.functions)
      for (const r of fn.ranges) if (r.endOffset > maxEnd) maxEnd = r.endOffset;
    const total = e.source?.length ?? maxEnd;
    return { url: jsKeys[i], total, used: jsUsedRanges(e.functions, total) };
  });
  const cssKeys = distinctContentKeys(css.map((e) => ({ url: e.url, content: e.text })));
  const cssItems = css.map((e, i) => ({
    url: cssKeys[i],
    total: e.text?.length ?? 0,
    used: e.ranges.map((r) => [r.start, r.end] as [number, number]),
  }));
  // total = source/text length (or max offset); inline/anonymous entries skipped
  const jsPerUrl = groupRangesByUrl(jsItems, { skipEmptyUrl: true });
  const cssPerUrl = groupRangesByUrl(cssItems, { skipEmptyUrl: true });
  return {
    coverage: { js: toCoverageReport(jsPerUrl), css: toCoverageReport(cssPerUrl) },
    artifact: { js: jsPerUrl, css: cssPerUrl },
  };
}
