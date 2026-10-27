/**
 * Crawl every entry (three cases each, one for an oracle entry) and write the
 * results table into README.md between the `results:start` / `results:end`
 * markers.
 *
 *   pnpm report                       # every entry
 *   PATTERN=null-relation pnpm report # only the named ones (the rest of the table is kept)
 *
 * tsx is fine here: chaosbringer is imported from its built dist, so the
 * functions it hands to page.evaluate are plain JS, and the pages are HTML
 * strings.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCase } from "../src/detect.js";
import { describeInjection } from "../src/inject.js";
import type { DataPattern } from "../src/pattern.js";
import { loadPatterns } from "../src/registry.js";
import { type CaseRun, describeObserved, judgeBuggy, judgeClean, judgeDelivered } from "../src/verdict.js";

const readme = join(dirname(fileURLToPath(import.meta.url)), "..", "README.md");
const START = "<!-- results:start -->";
const END = "<!-- results:end -->";

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const clip = (s: string, max = 90) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const exits = (run: CaseRun) => `${run.exitCode} / ${run.defaultExit}`;

/** `pass` when the verdict and the delivery check both pass, else the first problem, in bold. */
function verdictCell(p: DataPattern, run: CaseRun, problems: string[], pass: string): string {
  const first = [...problems, ...judgeDelivered(p, run)][0];
  return first === undefined ? pass : `**${cell(clip(first))}**`;
}

async function row(p: DataPattern): Promise<string> {
  const link = `[${p.id}](src/patterns/${p.id}.ts)`;
  if (p.expect.signal === "none") {
    const run = await runCase(p, "fixed", "none");
    const clean = verdictCell(p, run, judgeClean(p, run), "clean");
    console.log(`${p.id}: ${clean}`);
    return `| ${link} | ${p.category} | – | – | – | – | ${clean} (exit ${exits(run)}) | ${cell(p.fix)} |`;
  }
  const buggyBad = await runCase(p, "buggy", "bad");
  const buggyBenign = await runCase(p, "buggy", "benign");
  const fixedBad = await runCase(p, "fixed", "bad");
  const reported = buggyBad.signals.map((s) => `\`${cell(clip(describeObserved(s)))}\``).join("<br>");
  const flagged = verdictCell(p, buggyBad, judgeBuggy(p, buggyBad), reported);
  const control = verdictCell(p, buggyBenign, judgeClean(p, buggyBenign), "clean");
  const fixed = verdictCell(p, fixedBad, judgeClean(p, fixedBad), "clean");
  console.log(`${p.id}: buggy ${flagged} | control ${control} | fixed ${fixed}`);
  return `| ${link} | ${p.category} | ${describeInjection(p)} | ${flagged} | ${exits(buggyBad)} | ${control} | ${fixed} | ${cell(p.fix)} |`;
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

// Keep rows of entries this run did not crawl (PATTERN=…), replace the rest.
const rows = parseRows(text.slice(start, end));
for (const p of patterns) rows.set(p.id, await row(p));
const known = new Set((await loadPatterns("")).map((p) => p.id));
const body = [...rows.entries()]
  .filter(([id]) => known.has(id))
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, line]) => line);

const table = [
  "",
  `Measured by \`pnpm report\` on ${new Date().toISOString().slice(0, 10)}: one crawl per case, \`strict\` on, the catalog suite. "exit" is the buggy + bad run's exit code with \`strict\` / without it.`,
  "",
  "| entry | category | data via | buggy + bad data: reported | exit | buggy + benign data | fixed + bad data | fix |",
  "|---|---|---|---|---|---|---|---|",
  ...body,
  "",
].join("\n");

writeFileSync(readme, text.slice(0, start + START.length) + table + text.slice(end));
console.log(`wrote ${body.length} row(s) to README.md`);
