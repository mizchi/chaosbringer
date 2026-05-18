/**
 * benchmark-rubric.ts — A/B compare regex-only vs LLM-judged scoring
 * across all past eval runs.
 *
 * Usage:
 *   pnpm benchmark-rubric
 *
 * Behavior:
 *   - Walks /tmp/wom-* directories.
 *   - For each run, re-loads the saved transcript + journal + report.
 *   - Calls scoreScenario TWICE:
 *       (a) with llmVerdicts disabled — pure regex
 *       (b) with llmVerdicts pre-populated from /tmp/wom-<run>/llm-verdicts.json
 *           if present (judge results written by an external tool)
 *   - Reports per-run, per-criterion verdict deltas.
 *
 * To populate llm-verdicts.json:
 *   - Set ANTHROPIC_API_KEY and re-run `pnpm score <scenario> <run>` —
 *     the eval-score CLI will dispatch all __llmJudge callbacks and
 *     write results into the report.json. Alternatively, an offline
 *     human-or-agent rubric pass can write verdicts manually:
 *       echo '{"stated-hypothesis": true, "read-target-source": false}' \
 *         > /tmp/wom-<run>/llm-verdicts.json
 *
 * Output:
 *   Markdown table of (run × criterion) → (regex verdict, llm verdict,
 *   delta). Lines where delta=YES highlight regex brittleness.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { scoreScenario } from "../../../packages/aws-faults/src/wheel/scoring.ts";
import { scenarios } from "../../../packages/aws-faults/src/wheel/index.ts";
import type { ToolUseRecord } from "../../../packages/aws-faults/src/wheel/types.ts";
import type { DrillReport } from "../../../packages/aws-faults/src/orchestrator.ts";

interface RunData {
  runId: string;
  scenarioId: string;
  transcript: string;
  toolUses: ToolUseRecord[];
  journalContents: string[];
  probeTrace?: string;
  llmVerdicts?: Record<string, boolean>;
  customerProbe?: { rate: number; sampleN: number };
  chaosSnapshot?: { rules: { id: string }[]; stats: { ruleId: string; matched: number; skipped: number }[] };
}

function loadRun(dir: string): RunData | null {
  const reportPath = join(dir, "report.json");
  const transcriptPath = join(dir, "transcript.txt");
  if (!existsSync(reportPath) || !existsSync(transcriptPath)) return null;
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    scenarioId: string;
    customerProbe?: { rate: number; sampleN: number };
    chaosStats?: { ruleId: string; matched: number; skipped: number }[];
  };
  const transcript = readFileSync(transcriptPath, "utf8");
  const journal = existsSync(join(dir, "journal.md"))
    ? readFileSync(join(dir, "journal.md"), "utf8")
    : "";
  const toolUsesPath = join(dir, "tool-uses.jsonl");
  const toolUses: ToolUseRecord[] = existsSync(toolUsesPath)
    ? readFileSync(toolUsesPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  const probesPath = join(dir, "probes.log");
  const probeTrace = existsSync(probesPath) ? readFileSync(probesPath, "utf8") : undefined;
  const llmPath = join(dir, "llm-verdicts.json");
  const llmVerdicts = existsSync(llmPath)
    ? (JSON.parse(readFileSync(llmPath, "utf8")) as Record<string, boolean>)
    : undefined;
  const runId = dir.replace(/^.*\/wom-/, "");
  return {
    runId,
    scenarioId: report.scenarioId,
    transcript,
    toolUses,
    journalContents: journal ? [journal] : [],
    probeTrace,
    llmVerdicts,
    customerProbe: report.customerProbe,
    chaosSnapshot: report.chaosStats ? { rules: [], stats: report.chaosStats } : undefined,
  };
}

function syntheticDrillReport(): DrillReport {
  return {
    drillId: "x",
    passed: true,
    baseline: [],
    injectedByPhase: [],
    injected: [],
    recovery: Array.from({ length: 30 }, () => ({ ok: true, latencyMs: 30, errorRate: 0 })),
    durationMs: 90_000,
    recovered: true,
  };
}

const runs: RunData[] = [];
for (const entry of readdirSync("/tmp")) {
  if (!entry.startsWith("wom-")) continue;
  const dir = join("/tmp", entry);
  if (!statSync(dir).isDirectory()) continue;
  const run = loadRun(dir);
  if (run) runs.push(run);
}

console.log(`# Rubric A/B benchmark — ${runs.length} runs\n`);
console.log("| Run | Scenario | Criterion | Regex | LLM | Delta |");
console.log("|---|---|---|---|---|---|");

let totalDeltas = 0;
let llmCovered = 0;

for (const run of runs) {
  const factory = scenarios.catalog.find((s) => s.id === run.scenarioId)?.factory;
  if (!factory) continue;
  const scenario = factory({
    probeUrl: "http://localhost:3000/health",
    customerUrl: "http://localhost:3000/orders",
  });

  // Pass A: regex-only
  const reportRegex = scoreScenario({
    scenario,
    drillReport: syntheticDrillReport(),
    transcript: run.transcript,
    toolUses: run.toolUses,
    journalContents: run.journalContents,
    postRunProbes: run.customerProbe
      ? { "customer-impact-recovered": run.customerProbe }
      : {},
    postRunChaosSnapshot: run.chaosSnapshot,
    probeTrace: run.probeTrace,
    // No llmVerdicts → primitives fall back to regex
  });

  // Pass B: with llm verdicts (if available)
  const reportLLM = run.llmVerdicts
    ? scoreScenario({
        scenario,
        drillReport: syntheticDrillReport(),
        transcript: run.transcript,
        toolUses: run.toolUses,
        journalContents: run.journalContents,
        postRunProbes: run.customerProbe
          ? { "customer-impact-recovered": run.customerProbe }
          : {},
        postRunChaosSnapshot: run.chaosSnapshot,
        probeTrace: run.probeTrace,
        llmVerdicts: run.llmVerdicts,
      })
    : null;

  if (reportLLM) llmCovered++;

  // Compare per-criterion verdicts on the LLM-judgeable primitives only.
  const LLM_JUDGEABLE = new Set([
    "stated-hypothesis",
    "read-target-source",
    "checked-chaos-stats",
    "no-extra-retries",
    "minimal-change",
  ]);
  for (const c of reportRegex.criteria) {
    if (!LLM_JUDGEABLE.has(c.id)) continue;
    const llmVerdict = reportLLM?.criteria.find((cc) => cc.id === c.id)?.passed;
    const delta = llmVerdict !== undefined && llmVerdict !== c.passed;
    if (delta) totalDeltas++;
    const llmCell = llmVerdict === undefined ? "—" : llmVerdict ? "✅" : "❌";
    const regexCell = c.passed ? "✅" : "❌";
    const deltaCell = delta ? "**Δ**" : "";
    console.log(
      `| ${run.runId} | ${run.scenarioId} | ${c.id} | ${regexCell} | ${llmCell} | ${deltaCell} |`,
    );
  }
}

console.log();
console.log(`## Summary`);
console.log(`- Runs analyzed: ${runs.length}`);
console.log(`- Runs with LLM verdicts: ${llmCovered}`);
console.log(`- Total regex/LLM verdict deltas: ${totalDeltas}`);
if (llmCovered === 0) {
  console.log();
  console.log(`No /tmp/wom-*/llm-verdicts.json files found.`);
  console.log(`To populate them, either:`);
  console.log(`  - Set ANTHROPIC_API_KEY and re-run \`pnpm score <scenario> <run>\``);
  console.log(`    (eval-score will write llm verdicts to the run dir)`);
  console.log(`  - Or manually create /tmp/wom-<run>/llm-verdicts.json with`);
  console.log(`    \`{"stated-hypothesis": true, "read-target-source": ...}\``);
}
