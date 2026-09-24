#!/usr/bin/env node
/**
 * Union JS/CSS coverage across every scenario run to find code that NO scenario
 * used — dead-code / over-shipping candidates — and to judge whether chunks are
 * split well (a chunk the whole E2E suite barely touches is split too coarsely or
 * shipped needlessly).
 *
 * Each PERF_COV=1 run writes <slug>.run<idx>.coverage.json (per-url used byte
 * ranges). This merges them: a byte is "used" if ANY scenario executed it.
 *
 * Usage:
 *   PERF_COV=1 pnpm exec playwright test       # run the whole suite
 *   node scripts/coverage.mjs [--min=30]        # union; flag urls under --min% used
 */
import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve(process.env.PERF_OUT_DIR ?? "perf-results");
const flags = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => a.replace(/^--/, "").split("=")),
);
const minPct = Number(flags.min ?? "30");

function mergeRanges(ranges) {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [[sorted[0][0], sorted[0][1]]];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    const last = out[out.length - 1];
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}
const rangesLen = (r) => r.reduce((a, [s, e]) => a + (e - s), 0);
const kb = (b) => Math.round(b / 102.4) / 10;
const shorten = (url) => url.replace(/^https?:\/\/[^/]+/, "").slice(0, 70) || url;

if (!fs.existsSync(DIR)) {
  console.error(`${DIR} not found. Run the suite with PERF_COV=1 first.`);
  process.exit(1);
}
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".coverage.json"));
if (files.length === 0) {
  console.error("No coverage artifacts (<slug>.coverage.json). Run with PERF_COV=1.");
  process.exit(1);
}

// kind -> url -> { total, used: ranges[] }
const acc = { js: new Map(), css: new Map() };
for (const f of files) {
  const art = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
  for (const kind of ["js", "css"]) {
    for (const item of art[kind] ?? []) {
      const cur = acc[kind].get(item.url) ?? { total: 0, used: [] };
      cur.total = Math.max(cur.total, item.total);
      cur.used.push(...item.used);
      acc[kind].set(item.url, cur);
    }
  }
}

function summarize(kind) {
  const rows = [...acc[kind].entries()].map(([url, v]) => {
    const used = rangesLen(mergeRanges(v.used));
    return {
      url,
      total: v.total,
      used,
      pct: v.total > 0 ? Math.round((used / v.total) * 1000) / 10 : 0,
    };
  });
  const total = rows.reduce((a, r) => a + r.total, 0);
  const used = rows.reduce((a, r) => a + r.used, 0);
  rows.sort((a, b) => b.total - b.used - (a.total - a.used));
  return { rows, total, used, pct: total > 0 ? Math.round((used / total) * 1000) / 10 : 0 };
}

console.log(`\n[coverage] union across ${files.length} scenario run(s)`);
let deadBytes = 0;
for (const kind of ["js", "css"]) {
  const s = summarize(kind);
  if (s.total === 0) continue;
  console.log(
    `\n  ${kind.toUpperCase()}  ${s.pct}% used overall  (${kb(s.used)}/${kb(s.total)}KB, ${kb(s.total - s.used)}KB never used)`,
  );
  const dead = s.rows.filter((r) => r.total >= 5_000 && r.pct === 0);
  const low = s.rows.filter((r) => r.total >= 5_000 && r.pct > 0 && r.pct < minPct);
  if (dead.length) {
    console.log(`    never used by any scenario (dead-code / over-shipping):`);
    for (const r of dead) {
      deadBytes += r.total;
      console.log(`      ${String(kb(r.total)).padStart(8)}KB  ${shorten(r.url)}`);
    }
  }
  if (low.length) {
    console.log(`    under ${minPct}% used (split too coarse / lazy-load candidate):`);
    for (const r of low) {
      console.log(
        `      ${String(r.pct).padStart(5)}% used  ${String(kb(r.total - r.used)).padStart(7)}KB unused  ${shorten(r.url)}`,
      );
    }
  }
  if (!dead.length && !low.length) {
    console.log(`    all chunks >= ${minPct}% used — split looks reasonable.`);
  }
}
console.log("");
