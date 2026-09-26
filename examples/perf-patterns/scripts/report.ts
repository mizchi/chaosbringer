/**
 * Measure every pattern (both variants) and write the results table into
 * README.md between the `results:start` / `results:end` markers.
 *
 *   pnpm report                    # all patterns, 3 runs each
 *   PATTERN=retry-storm pnpm report  # only the named ones (the rest of the table is kept)
 *   PERF_PATTERN_RUNS=5 pnpm report
 *
 * tsx is fine here: chaosbringer is imported from its built dist, so the
 * functions it hands to page.evaluate are plain JS, and the pattern pages are
 * HTML strings.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { measurePattern, type PatternMeasurement } from "../src/measure.js";
import { loadPatterns } from "../src/registry.js";

const readme = join(dirname(fileURLToPath(import.meta.url)), "..", "README.md");
const START = "<!-- results:start -->";
const END = "<!-- results:end -->";
const runs = Number(process.env.PERF_PATTERN_RUNS ?? 3);

const fmt = (n: number | null) =>
  n === null ? "–" : Number.isInteger(n) ? String(n) : n.toFixed(Math.abs(n) >= 100 ? 0 : 1);

function improvement(m: Pick<PatternMeasurement, "improvement">, slow: number | null): string {
  const { absolute, ratio, ok } = m.improvement;
  if (absolute === null || ratio === null || slow === null) return "–";
  const pct = slow === 0 ? 0 : (absolute / slow) * 100;
  const times = Number.isFinite(ratio) ? `${ratio.toFixed(ratio >= 10 ? 0 : 1)}×` : "∞×";
  return `${pct >= 0 ? "−" : "+"}${Math.abs(pct).toFixed(Math.abs(pct) > 99 && Math.abs(pct) < 100 ? 1 : 0)}% (${times})${ok ? "" : " **below threshold**"}`;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function row(m: PatternMeasurement): string {
  const p = m.pattern;
  const keys = m.slow.matchedKeys.length ? m.slow.matchedKeys.map((k) => `\`${k}\``).join("<br>") : `\`${p.expect.key}\``;
  const faults = p.crawl.faults?.length
    ? `<br>under ${p.crawl.faults.map((f) => `\`${f.name ?? f.fault.kind}\``).join(", ")}`
    : "";
  // Metrics the pattern also asserts go under the main one, with their own numbers.
  const also = m.also
    .map((a) => `<br>also \`${a.expect.metric}\`: ${fmt(a.slow)} → ${fmt(a.fixed)}, ${improvement(a, a.slow)}`)
    .join("");
  return `| [${p.id}](src/patterns/${p.id}.ts) | ${p.category} | ${keys}<br>\`${p.expect.metric}\`${faults}${also} | ${fmt(m.slow.median)} | ${fmt(m.fixed.median)} | ${improvement(m, m.slow.median)} | ${cell(p.fix)} |`;
}

function parseRows(table: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of table.split("\n")) {
    const id = /^\| \[([^\]]+)\]/.exec(line)?.[1];
    if (id) rows.set(id, line);
  }
  return rows;
}

const patterns = await loadPatterns();
const text = readFileSync(readme, "utf8");
const start = text.indexOf(START);
const end = text.indexOf(END);
if (start < 0 || end < start) throw new Error(`README.md needs ${START} … ${END} markers`);

// Keep rows of patterns this run did not measure (PATTERN=…), replace the rest.
const rows = parseRows(text.slice(start, end));
for (const pattern of patterns) {
  process.stdout.write(`measuring ${pattern.id} (${runs} runs per variant)… `);
  const m = await measurePattern(pattern, { runs });
  rows.set(pattern.id, row(m));
  console.log(`slow ${fmt(m.slow.median)} → fixed ${fmt(m.fixed.median)} ${improvement(m, m.slow.median)}`);
  for (const a of m.also) {
    console.log(`  also ${a.expect.metric}: slow ${fmt(a.slow)} → fixed ${fmt(a.fixed)} ${improvement(a, a.slow)}`);
  }
  const top = m.slow.slowestActions[0];
  if (top) console.log(`  slow variant's slowest action: ${top.key} ${fmt(top.durationMs)} ms, blocking ${fmt(top.blockingMs)} ms`);
  for (const d of m.slow.degradation.slice(0, 3)) {
    console.log(`  degradation ${d.key} [${d.fault}]: effectiveMs +${fmt(d.delta.effectiveMs)}, requestCount +${fmt(d.delta.requestCount)}`);
  }
}
const known = new Set((await loadPatterns("")).map((p) => p.id));
const body = [...rows.entries()]
  .filter(([id]) => known.has(id))
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, line]) => line);

const table = [
  "",
  `Medians over ${runs} crawls per variant at the pattern's seed; measured by \`pnpm report\` on ${new Date().toISOString().slice(0, 10)}.`,
  "",
  "| pattern | category | what chaosbringer flags (perfKey · metric) | slow | fixed | improvement | fix |",
  "|---|---|---|---|---|---|---|",
  ...body,
  "",
].join("\n");

writeFileSync(readme, text.slice(0, start + START.length) + table + text.slice(end));
console.log(`wrote ${body.length} row(s) to README.md`);
