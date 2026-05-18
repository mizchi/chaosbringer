/**
 * eval-replay.ts — deterministic offline re-score of a recorded run (issue #117).
 *
 * Usage:
 *   pnpm replay <fixture-name>
 *   pnpm replay <fixture-name> --tolerance=0.02
 *
 * Reads everything from fixtures/<fixture-name>/:
 *   - journal.md             (required)
 *   - transcript.txt         (optional; falls back to journal)
 *   - tool-uses.jsonl        (optional; inferred from journal if absent)
 *   - probes.log             (optional; empty drift if absent)
 *   - llm-verdicts.json      (REQUIRED for offline replay — without it, criteria
 *                            with __llmJudge fall back to regex which can be flaky)
 *   - _replay-inputs.json    (REQUIRED — { customerProbe, chaosSnapshot })
 *   - expected.json          (REQUIRED — { score, criteria: [{id, passed}] })
 *
 * Runs scoreScenario WITHOUT hitting any live env (no kumo, no /orders probe,
 * no LLM API). Compares result with expected.json and exits non-zero on drift
 * beyond tolerance.
 *
 * What this catches:
 *   - Rubric primitive regressions ("we changed didNotAddRetries and now this
 *     known-good run scores 5% lower")
 *   - Scoring pipeline regressions ("a refactor of scoreScenario broke
 *     weight aggregation")
 *   - Wire-format changes that silently invalidate fixtures
 *
 * What it does NOT catch:
 *   - Live env regressions (kumo / target behavior changes) — those need a
 *     separate live-agent gate (see #117 option B).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scenarios } from "../../../packages/aws-faults/src/wheel/index.ts";
import { scoreScenario } from "../../../packages/aws-faults/src/wheel/scoring.ts";
import type { ToolUseRecord } from "../../../packages/aws-faults/src/wheel/types.ts";
import type { DrillReport } from "../../../packages/aws-faults/src/orchestrator.ts";

const fixtureName = process.argv[2];
let tolerance = 0.02; // default ±2 percentage points
for (const arg of process.argv.slice(3)) {
  const m = arg.match(/^--tolerance=(.+)$/);
  if (m) tolerance = Number(m[1]);
}

if (!fixtureName) {
  console.error("usage: pnpm replay <fixture-name> [--tolerance=0.02]");
  console.error("       (looks for examples/aws-chaos-rehearsal/fixtures/<fixture-name>/)");
  process.exit(64);
}

const fixtureDir = resolve(import.meta.dirname, "..", "fixtures", fixtureName);
if (!existsSync(fixtureDir)) {
  console.error(`no fixture at ${fixtureDir}`);
  process.exit(1);
}

function readJSON<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
function readJSONOrUndefined<T>(path: string): T | undefined {
  return existsSync(path) ? readJSON<T>(path) : undefined;
}

const expected = readJSON<{
  scenarioId: string;
  score: number;
  passed: boolean;
  criteria: { id: string; passed: boolean }[];
}>(join(fixtureDir, "expected.json"));

const factory = scenarios.catalog.find((s) => s.id === expected.scenarioId)?.factory;
if (!factory) {
  console.error(`unknown scenario in expected.json: ${expected.scenarioId}`);
  process.exit(1);
}
const scenario = factory({
  probeUrl: "http://localhost:3000/health",
  customerUrl: "http://localhost:3000/orders",
});

const journal = readFileSync(join(fixtureDir, "journal.md"), "utf8");
const transcriptPath = join(fixtureDir, "transcript.txt");
const transcript = existsSync(transcriptPath) ? readFileSync(transcriptPath, "utf8") : journal;
const toolUsesPath = join(fixtureDir, "tool-uses.jsonl");
const toolUses: ToolUseRecord[] = existsSync(toolUsesPath)
  ? readFileSync(toolUsesPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : inferToolUsesFromJournal(journal);

const replayInputs = readJSON<{
  customerProbe: { rate: number; sampleN: number };
  postRunProbes?: Record<string, { rate: number; sampleN: number }>;
  chaosSnapshot: { rules: { id: string }[]; stats: { ruleId: string; matched: number; skipped: number }[] };
}>(join(fixtureDir, "_replay-inputs.json"));

const llmVerdicts =
  readJSONOrUndefined<Record<string, boolean>>(join(fixtureDir, "llm-verdicts.json")) ?? {};

const probesPath = join(fixtureDir, "probes.log");
const probeTrace = existsSync(probesPath) ? readFileSync(probesPath, "utf8") : undefined;

const drillReport: DrillReport = synthesizeDrillReport(probeTrace);

const postRunProbes: Record<string, { rate: number; sampleN: number }> = {
  "customer-impact-recovered": replayInputs.customerProbe,
  ...(replayInputs.postRunProbes ?? {}),
};

const report = scoreScenario({
  scenario,
  drillReport,
  transcript,
  toolUses,
  journalContents: [journal],
  postRunProbes,
  postRunChaosSnapshot: replayInputs.chaosSnapshot,
  probeTrace,
  llmVerdicts,
});

// Compare with expected.
const drift = report.score - expected.score;
const driftPct = (drift * 100).toFixed(1);
const okScore = Math.abs(drift) <= tolerance;
const failedCriteria: string[] = [];
const expByID = new Map(expected.criteria.map((c) => [c.id, c.passed]));
for (const c of report.criteria) {
  const exp = expByID.get(c.id);
  if (exp !== undefined && exp !== c.passed) {
    failedCriteria.push(`${c.id}: expected ${exp ? "PASS" : "FAIL"}, got ${c.passed ? "PASS" : "FAIL"}`);
  }
}

console.log(`fixture:   ${fixtureName} (${expected.scenarioId})`);
console.log(`expected:  ${(expected.score * 100).toFixed(1)}%`);
console.log(`actual:    ${(report.score * 100).toFixed(1)}%`);
console.log(`drift:     ${drift >= 0 ? "+" : ""}${driftPct}pp (tolerance ±${(tolerance * 100).toFixed(1)}pp)`);
if (failedCriteria.length > 0) {
  console.log(`criteria mismatch:`);
  for (const f of failedCriteria) console.log(`  - ${f}`);
}

if (!okScore || failedCriteria.length > 0) {
  console.error(`REGRESSION: replay drifted from baseline.`);
  process.exit(1);
}
console.log("OK");

function synthesizeDrillReport(probeTrace: string | undefined): DrillReport {
  if (!probeTrace) {
    return {
      drillId: "replay",
      passed: true,
      baseline: [],
      injectedByPhase: [{ label: "peak", samples: [] }],
      injected: [],
      recovery: [],
      durationMs: 0,
      recovered: true,
    };
  }
  const samples = probeTrace
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(\d+) h=(\d+) o=(\d+)/);
      if (!m) return null;
      return { t: Number(m[1]), h: m[2] === "200", o: m[3] === "200" };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const recovery = samples.slice(-30).map((s) => ({ ok: s.o, latencyMs: 0, errorRate: s.o ? 0 : 1 }));
  const recovered = recovery.length >= 5 && recovery.filter((s) => s.ok).length / recovery.length >= 0.8;
  return {
    drillId: "replay",
    passed: recovered,
    baseline: [],
    injectedByPhase: [
      {
        label: "peak",
        samples: samples.slice(0, 30).map((s) => ({ ok: s.o, latencyMs: 0, errorRate: s.o ? 0 : 1 })),
      },
    ],
    injected: [],
    recovery,
    durationMs: samples.length * 300,
    recovered,
  };
}

function inferToolUsesFromJournal(journal: string): ToolUseRecord[] {
  const verbToTool: Record<string, string> = {
    read: "Read",
    investigate: "Bash",
    bash: "Bash",
    curl: "Bash",
    edit: "Edit",
    write: "Write",
    restart: "Bash",
    verify: "Bash",
    plan: "Bash",
    mitigate: "Edit",
  };
  const out: ToolUseRecord[] = [];
  for (const line of journal.split("\n")) {
    const m = line.match(/^T\+(\d+)s\s+(\w+):\s*(.+)/);
    if (!m) continue;
    const atSec = Number(m[1]);
    const verb = m[2]!.toLowerCase();
    const note = m[3]!;
    const name = verbToTool[verb] ?? "Bash";
    out.push({ name, input: note, atSec });
  }
  return out;
}
