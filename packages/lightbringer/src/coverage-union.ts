// Union of JS/CSS coverage across scenario runs: a byte is "used" if ANY run
// executed it, so what stays unused is code no scenario needed — dead-code /
// over-shipping candidates, and chunks split too coarsely. Pure; the driver is
// scripts/coverage.mjs, over the <slug>.run<N>.coverage.json artifacts.
import { mergeRanges, type CoverageArtifact } from "./analyze/coverage";

export type { CoverageArtifact };

export interface CoverageUnionRow {
  url: string;
  /** bytes (the largest size any run saw for the url) */
  total: number;
  used: number;
  /** used / total as a percentage, one decimal */
  pct: number;
}

export interface CoverageUnionKind {
  /** heaviest unused first */
  rows: CoverageUnionRow[];
  total: number;
  used: number;
  pct: number;
}

export interface CoverageUnion {
  js: CoverageUnionKind;
  css: CoverageUnionKind;
}

/** Resources smaller than this are too small to be worth flagging. */
export const COVERAGE_MIN_FLAG_BYTES = 5_000;
/** Default "under N% used" threshold for flagging a resource. */
export const DEFAULT_COVERAGE_MIN_PCT = 30;

const pctOf = (used: number, total: number) =>
  total > 0 ? Math.round((used / total) * 1000) / 10 : 0;

/**
 * Fold `next` into `acc`: one artifact whose used ranges are the union of
 * both, per kind and url. `unionCoverage([mergeCoverageArtifacts(a, b)])`
 * equals `unionCoverage([a, b])`, so a driver that sees artifacts one at a
 * time (a crawler, page after page) can keep one merged artifact instead of
 * every page's — its size is bounded by the resources, not by the pages.
 * Pure: neither input is mutated.
 */
export function mergeCoverageArtifacts(
  acc: Partial<CoverageArtifact>,
  next: Partial<CoverageArtifact>,
): CoverageArtifact {
  const merge = (kind: "js" | "css"): CoverageArtifact["js"] => {
    const byUrl = new Map<string, { url: string; total: number; used: Array<[number, number]> }>();
    for (const item of [...(acc[kind] ?? []), ...(next[kind] ?? [])]) {
      const cur = byUrl.get(item.url);
      if (!cur) {
        byUrl.set(item.url, { url: item.url, total: item.total, used: [...item.used] });
        continue;
      }
      cur.total = Math.max(cur.total, item.total);
      cur.used = mergeRanges([...cur.used, ...item.used]);
    }
    return [...byUrl.values()];
  };
  return { js: merge("js"), css: merge("css") };
}

/** Union the used ranges of every artifact, per kind and url. */
export function unionCoverage(artifacts: readonly Partial<CoverageArtifact>[]): CoverageUnion {
  const summarize = (kind: "js" | "css"): CoverageUnionKind => {
    const acc = new Map<string, { total: number; used: Array<[number, number]> }>();
    for (const art of artifacts) {
      for (const item of art[kind] ?? []) {
        const cur = acc.get(item.url) ?? { total: 0, used: [] };
        cur.total = Math.max(cur.total, item.total);
        cur.used.push(...item.used);
        acc.set(item.url, cur);
      }
    }
    const rows = [...acc.entries()].map(([url, v]) => {
      const used = mergeRanges(v.used).reduce((a, [s, e]) => a + (e - s), 0);
      return { url, total: v.total, used, pct: pctOf(used, v.total) };
    });
    const total = rows.reduce((a, r) => a + r.total, 0);
    const used = rows.reduce((a, r) => a + r.used, 0);
    rows.sort((a, b) => b.total - b.used - (a.total - a.used));
    return { rows, total, used, pct: pctOf(used, total) };
  };
  return { js: summarize("js"), css: summarize("css") };
}

const kb = (b: number) => Math.round(b / 102.4) / 10;
const shorten = (url: string) => url.replace(/^https?:\/\/[^/]+/, "").slice(0, 70) || url;

/**
 * The report scripts/coverage.mjs prints: each entry is one console.log call.
 * Flags resources >= 5 KB that no run used, and ones under `minPct` used.
 */
export function formatCoverageUnion(
  u: CoverageUnion,
  { runs, minPct = DEFAULT_COVERAGE_MIN_PCT }: { runs: number; minPct?: number },
): string[] {
  const out: string[] = [`\n[coverage] union across ${runs} scenario run(s)`];
  for (const kind of ["js", "css"] as const) {
    const s = u[kind];
    if (s.total === 0) continue;
    out.push(
      `\n  ${kind.toUpperCase()}  ${s.pct}% used overall  (${kb(s.used)}/${kb(s.total)}KB, ${kb(s.total - s.used)}KB never used)`,
    );
    const big = s.rows.filter((r) => r.total >= COVERAGE_MIN_FLAG_BYTES);
    const dead = big.filter((r) => r.pct === 0);
    const low = big.filter((r) => r.pct > 0 && r.pct < minPct);
    if (dead.length) {
      out.push(`    never used by any scenario (dead-code / over-shipping):`);
      for (const r of dead) out.push(`      ${String(kb(r.total)).padStart(8)}KB  ${shorten(r.url)}`);
    }
    if (low.length) {
      out.push(`    under ${minPct}% used (split too coarse / lazy-load candidate):`);
      for (const r of low) {
        out.push(
          `      ${String(r.pct).padStart(5)}% used  ${String(kb(r.total - r.used)).padStart(7)}KB unused  ${shorten(r.url)}`,
        );
      }
    }
    if (!dead.length && !low.length) {
      out.push(`    all chunks >= ${minPct}% used — split looks reasonable.`);
    }
  }
  out.push("");
  return out;
}
