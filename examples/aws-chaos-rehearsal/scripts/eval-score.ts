/**
 * eval-score.ts — score a finished eval run.
 *
 * Usage:
 *   pnpm score <scenario-id> <run-id> [--transcript=<path>]
 *
 * Reads:
 *   /tmp/wom-<run-id>/journal.md   — required, agent's journal
 *   /tmp/wom-<run-id>/transcript.txt  — optional; if missing, journal is used
 *   /tmp/wom-<run-id>/tool-uses.jsonl — optional; if missing, inferred from journal
 *
 * Hits the live kumo for chaos snapshot, hits /orders for customer impact.
 * Writes debrief.md + report.json into the run dir.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scenarios } from "../../../packages/aws-faults/src/wheel/index.ts";
import { scoreScenario } from "../../../packages/aws-faults/src/wheel/scoring.ts";
import type { ToolUseRecord } from "../../../packages/aws-faults/src/wheel/types.ts";
import type { DrillReport } from "../../../packages/aws-faults/src/orchestrator.ts";

const scenarioId = process.argv[2];
const runId = process.argv[3];
if (!scenarioId || !runId) {
  console.error("usage: pnpm score <scenario-id> <run-id>");
  process.exit(64);
}

const factory = scenarios.catalog.find((s) => s.id === scenarioId)?.factory;
if (!factory) {
  console.error(`unknown scenario: ${scenarioId}`);
  process.exit(64);
}

const workDir = `/tmp/wom-${runId}`;
const journalPath = join(workDir, "journal.md");
const transcriptPath = join(workDir, "transcript.txt");
const toolUsesPath = join(workDir, "tool-uses.jsonl");

if (!existsSync(journalPath)) {
  console.error(`no journal at ${journalPath} — did the agent run?`);
  process.exit(1);
}

const journalContents = [readFileSync(journalPath, "utf8")];
const transcript = existsSync(transcriptPath)
  ? readFileSync(transcriptPath, "utf8")
  : journalContents[0]; // fallback: score against journal-as-transcript

const toolUses: ToolUseRecord[] = existsSync(toolUsesPath)
  ? readFileSync(toolUsesPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : inferToolUsesFromJournal(journalContents[0]!);

// Hit the live env for ground-truth state at scoring time.
async function probeCustomer() {
  let ok = 0;
  const n = 30;
  for (let i = 0; i < n; i++) {
    try {
      const r = await fetch("http://localhost:3000/orders", {
        method: "POST",
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) ok++;
    } catch {
      /* fail */
    }
  }
  return { rate: ok / n, sampleN: n };
}

const customerProbe = await probeCustomer();
const chaosSnapshot = (await (await fetch("http://localhost:4566/kumo/chaos/rules")).json()) as {
  rules: { id: string }[];
  stats: { ruleId: string; matched: number; skipped: number }[];
};

const scenario = factory({
  probeUrl: "http://localhost:3000/health",
  customerUrl: "http://localhost:3000/orders",
});

// Use a minimal DrillReport — the harness measured the SLO during the run
// via the probe loop, but the scorer's `recoveredSlo` only needs to see
// that the recovery samples passed acceptance. We synthesize this from
// the probe log.
const drillReport: DrillReport = synthesizeDrillReport(workDir, customerProbe);

// Iterate over all rubric criteria; any with a __probe callback runs at
// scoring time. customer-impact-recovered already ran above; skip it.
const postRunProbes: Record<string, { rate: number; sampleN: number }> = {
  "customer-impact-recovered": customerProbe,
};
for (const c of scenario.rubric) {
  if (c.id === "customer-impact-recovered") continue;
  const probe = (c as { __probe?: () => Promise<{ rate: number; sampleN: number }> }).__probe;
  if (typeof probe === "function") {
    try {
      postRunProbes[c.id] = await probe();
    } catch (err) {
      console.error(`[score] probe ${c.id} failed: ${err}`);
    }
  }
}

const report = scoreScenario({
  scenario,
  drillReport,
  transcript,
  toolUses,
  journalContents,
  postRunProbes,
  postRunChaosSnapshot: chaosSnapshot,
});

writeFileSync(join(workDir, "debrief.md"), report.debrief);
writeFileSync(
  join(workDir, "report.json"),
  JSON.stringify(
    {
      scenarioId: report.scenarioId,
      runId,
      passed: report.passed,
      score: report.score,
      criteria: report.criteria,
      redHerringsHit: report.redHerringsHit,
      customerProbe,
      chaosStats: chaosSnapshot.stats,
    },
    null,
    2,
  ),
);

console.log(report.debrief);
console.log();
console.log(`Score: ${(report.score * 100).toFixed(0)}%`);
console.log(`Customer impact (post-run, 30 samples): ${(customerProbe.rate * 100).toFixed(0)}%`);
console.log(`Artifacts: ${workDir}/{debrief.md,report.json}`);

function inferToolUsesFromJournal(journal: string): ToolUseRecord[] {
  // Each journal line is "T+Ns <verb>: <note>". Map common verbs to tool names.
  const verbToTool: Record<string, string> = {
    read: "Read",
    investigate: "Bash",
    bash: "Bash",
    curl: "Bash",
    edit: "Edit",
    write: "Write",
    restart: "Bash",
    verify: "Bash",
    plan: "Bash", // approximate
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

function synthesizeDrillReport(
  workDir: string,
  customerProbe: { rate: number; sampleN: number },
): DrillReport {
  // The probe log is `T h=NNN o=NNN` per 300ms. Read it for an SLO curve.
  const probesPath = join(workDir, "probes.log");
  const samples = existsSync(probesPath)
    ? readFileSync(probesPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const m = line.match(/^(\d+) h=(\d+) o=(\d+)/);
          if (!m) return null;
          return {
            t: Number(m[1]),
            h: m[2] === "200",
            o: m[3] === "200",
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
    : [];
  // Use the LAST 30 samples as the "recovery" window. Earlier samples are
  // the chaos peak. Both are recorded for the report.
  const recovery = samples.slice(-30).map((s) => ({
    ok: s.o,
    latencyMs: 0,
    errorRate: s.o ? 0 : 1,
  }));
  const recoveredSlo =
    recovery.length >= 5 && recovery.filter((s) => s.ok).length / recovery.length >= 0.8;
  return {
    drillId: "live",
    passed: recoveredSlo,
    baseline: [],
    injectedByPhase: [
      {
        label: "peak",
        samples: samples.slice(0, 30).map((s) => ({
          ok: s.o,
          latencyMs: 0,
          errorRate: s.o ? 0 : 1,
        })),
      },
    ],
    injected: [],
    recovery,
    durationMs: samples.length * 300,
    recovered: recoveredSlo,
  };
}
