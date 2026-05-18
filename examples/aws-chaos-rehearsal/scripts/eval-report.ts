/**
 * eval-report.ts — aggregate report across all eval runs.
 *
 * Walks /tmp/wom-* directories, reads each run's report.json, and
 * produces a single master Markdown report:
 *
 *   - Per-scenario stats: count, mean, max, min, criteria-failure
 *     distribution
 *   - Catalog-wide: total runs, mean across all, scenarios at 100%
 *     best-of-N
 *   - Most-failing rubric criteria across the catalog (which
 *     primitives are most often wrong?)
 *   - Time-to-recovery distribution (from probes.log per run)
 *
 * Used to answer "after N runs, what does the catalog actually say
 * about agent capability?" The output is the artifact we'd publish
 * to summarize a multi-shot sweep.
 *
 * Usage:
 *   pnpm report             — print to stdout
 *   pnpm report > out.md    — capture to file
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

interface RunReport {
  scenarioId: string;
  runId: string;
  passed: boolean;
  score: number;
  criteria: { id: string; description: string; passed: boolean; weight: number }[];
  redHerringsHit: string[];
  customerProbe?: { rate: number; sampleN: number };
  chaosStats?: { ruleId: string; matched: number; skipped: number }[];
  /** Inferred time-to-recovery from probes.log, seconds. -1 if unknown. */
  timeToRecoverySec: number;
  /** Whether the run had an llm-verdicts file. */
  llmJudged: boolean;
}

function inferTimeToRecovery(workDir: string): number {
  const probesPath = join(workDir, "probes.log");
  if (!existsSync(probesPath)) return -1;
  const lines = readFileSync(probesPath, "utf8").split("\n").filter(Boolean);
  type Sample = { t: number; o: number };
  const samples: Sample[] = [];
  for (const line of lines) {
    const m = line.match(/^(\d+)\s+h=\d+\s+o=(\d+)/);
    if (m) samples.push({ t: Number(m[1]), o: Number(m[2]) });
  }
  if (samples.length === 0) return -1;
  const firstFailIdx = samples.findIndex((s) => s.o !== 200);
  if (firstFailIdx === -1) return 0; // never failed
  const firstFailT = samples[firstFailIdx]!.t;
  const GREEN_STREAK = 10;
  for (let i = firstFailIdx; i <= samples.length - GREEN_STREAK; i++) {
    const window = samples.slice(i, i + GREEN_STREAK);
    if (window.every((s) => s.o === 200)) {
      return window[0]!.t - firstFailT;
    }
  }
  return -1; // never sustained-green
}

const runs: RunReport[] = [];
for (const entry of readdirSync("/tmp")) {
  if (!entry.startsWith("wom-")) continue;
  const dir = join("/tmp", entry);
  if (!statSync(dir).isDirectory()) continue;
  const reportPath = join(dir, "report.json");
  if (!existsSync(reportPath)) continue;
  try {
    const r = JSON.parse(readFileSync(reportPath, "utf8"));
    runs.push({
      scenarioId: r.scenarioId,
      runId: entry.replace(/^wom-/, ""),
      passed: r.passed,
      score: r.score,
      criteria: r.criteria,
      redHerringsHit: r.redHerringsHit ?? [],
      customerProbe: r.customerProbe,
      chaosStats: r.chaosStats,
      timeToRecoverySec: inferTimeToRecovery(dir),
      llmJudged: existsSync(join(dir, "llm-verdicts.json")),
    });
  } catch {
    // skip malformed
  }
}

// Group by scenario.
const byScenario = new Map<string, RunReport[]>();
for (const r of runs) {
  const list = byScenario.get(r.scenarioId) ?? [];
  list.push(r);
  byScenario.set(r.scenarioId, list);
}

// Format the report.
const lines: string[] = [];
const now = new Date().toISOString();
lines.push(`# Eval catalog master report`);
lines.push("");
lines.push(`Generated: ${now}`);
lines.push(`Source: ${runs.length} runs across ${byScenario.size} scenarios`);
lines.push("");

// Catalog summary.
const catalogMean =
  runs.reduce((s, r) => s + r.score, 0) / Math.max(1, runs.length);
const fullScoreCount = [...byScenario.values()].filter(
  (rs) => Math.max(...rs.map((r) => r.score)) >= 0.99,
).length;
lines.push(`## Catalog`);
lines.push("");
lines.push(`- Runs: **${runs.length}**`);
lines.push(`- Scenarios: **${byScenario.size}**`);
lines.push(`- Catalog mean score: **${(catalogMean * 100).toFixed(0)}%**`);
lines.push(`- Scenarios with at least one 100% run: **${fullScoreCount}** of ${byScenario.size}`);
lines.push(`- Runs with LLM-judged verdicts loaded: **${runs.filter((r) => r.llmJudged).length}**`);
lines.push("");

// Per-scenario table.
lines.push(`## Per-scenario summary`);
lines.push("");
lines.push("| Scenario | N | Best | Mean | Min | Median TTR (s) |");
lines.push("|---|---|---|---|---|---|");
const scenarioRows = [...byScenario.entries()]
  .map(([id, rs]) => {
    const scores = rs.map((r) => r.score).sort((a, b) => a - b);
    const ttrs = rs.map((r) => r.timeToRecoverySec).filter((t) => t >= 0).sort((a, b) => a - b);
    const med = ttrs.length === 0 ? "—" : ttrs[Math.floor(ttrs.length / 2)]!.toString();
    const mean = scores.reduce((s, x) => s + x, 0) / scores.length;
    return { id, n: rs.length, best: Math.max(...scores), mean, min: Math.min(...scores), med };
  })
  .sort((a, b) => b.best - a.best);
for (const r of scenarioRows) {
  lines.push(
    `| ${r.id} | ${r.n} | ${(r.best * 100).toFixed(0)}% | ${(r.mean * 100).toFixed(0)}% | ${(r.min * 100).toFixed(0)}% | ${r.med} |`,
  );
}
lines.push("");

// Criterion failure distribution.
const critFail = new Map<string, { fails: number; total: number; weight: number }>();
for (const r of runs) {
  for (const c of r.criteria) {
    const cur = critFail.get(c.id) ?? { fails: 0, total: 0, weight: c.weight };
    cur.total++;
    if (!c.passed) cur.fails++;
    critFail.set(c.id, cur);
  }
}
lines.push(`## Most-failing rubric criteria`);
lines.push("");
lines.push(
  `Across all runs, where the rubric flagged anti-patterns most often. ` +
    `Useful for prioritizing rubric refinement (high-fail-rate criteria are ` +
    `either catching real issues OR being too strict — both worth investigation).`,
);
lines.push("");
lines.push("| Criterion | Fail rate | Weight | Total runs |");
lines.push("|---|---|---|---|");
const critRows = [...critFail.entries()]
  .map(([id, stats]) => ({ id, ...stats, rate: stats.fails / stats.total }))
  .sort((a, b) => b.rate - a.rate);
for (const c of critRows) {
  if (c.fails === 0) continue;
  lines.push(`| ${c.id} | ${(c.rate * 100).toFixed(0)}% (${c.fails}/${c.total}) | ${c.weight} | ${c.total} |`);
}
lines.push("");

// Time-to-recovery distribution.
const ttrAll = runs.map((r) => r.timeToRecoverySec).filter((t) => t > 0).sort((a, b) => a - b);
if (ttrAll.length > 0) {
  const p50 = ttrAll[Math.floor(ttrAll.length / 2)];
  const p95 = ttrAll[Math.floor(ttrAll.length * 0.95)];
  const max = ttrAll[ttrAll.length - 1];
  lines.push(`## Time-to-recovery distribution`);
  lines.push("");
  lines.push(`Across ${ttrAll.length} runs where SLO recovered:`);
  lines.push("");
  lines.push(`- p50: **${p50}s**`);
  lines.push(`- p95: **${p95}s**`);
  lines.push(`- max: **${max}s**`);
  lines.push("");
}

// Red-herrings hit.
const herrings = new Map<string, number>();
for (const r of runs) {
  for (const h of r.redHerringsHit) {
    herrings.set(h, (herrings.get(h) ?? 0) + 1);
  }
}
if (herrings.size > 0) {
  lines.push(`## Red herrings caught`);
  lines.push("");
  lines.push("| Hypothesis followed | Count |");
  lines.push("|---|---|");
  for (const [h, c] of [...herrings.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${h} | ${c} |`);
  }
  lines.push("");
}

lines.push(`## Run index`);
lines.push("");
lines.push(`Full run list, newest scenarios first:`);
lines.push("");
for (const [id, rs] of scenarioRows.map((r) => [r.id, byScenario.get(r.id)!] as const)) {
  lines.push(`### ${id} (${rs.length} runs)`);
  for (const r of rs.sort((a, b) => a.runId.localeCompare(b.runId))) {
    const ttr = r.timeToRecoverySec >= 0 ? `${r.timeToRecoverySec}s` : "—";
    const judged = r.llmJudged ? " 🧑‍⚖️" : "";
    lines.push(`- **${r.runId}** — score ${(r.score * 100).toFixed(0)}%, ttr ${ttr}${judged}`);
  }
  lines.push("");
}

console.log(lines.join("\n"));
