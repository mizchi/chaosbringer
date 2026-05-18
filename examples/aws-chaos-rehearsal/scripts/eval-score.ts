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
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scenarios } from "../../../packages/aws-faults/src/wheel/index.ts";
import { scoreScenario } from "../../../packages/aws-faults/src/wheel/scoring.ts";
import type { ToolUseRecord } from "../../../packages/aws-faults/src/wheel/types.ts";
import type { DrillReport } from "../../../packages/aws-faults/src/orchestrator.ts";
import { RecipeStore, scenarioLoadFromStore } from "chaosbringer";

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
//
// Two probe modes, in priority order:
//   (1) chaosbringer journey-based probe — used when a recipe library
//       exists at recipes/<scenarioId>/. Runs N virtual users through a
//       verified journey (e.g. place order, then verify the order is
//       actually readable). Catches silent-data-loss, duplicate-write,
//       and stale-read failures that the curl probe is blind to.
//   (2) Legacy curl probe — POST /orders × 30. Used when no recipe
//       library is present for the scenario. Returns success rate only.
async function probeCustomerViaJourney(scenarioId: string) {
  const recipesDir = resolve(import.meta.dirname, "..", "recipes", scenarioId);
  if (!existsSync(recipesDir)) return null;
  // Copy the source recipes to a tmp dir so the RecipeStore's stats
  // updates (every replay records success/fail) don't mutate the
  // committed files.
  const ephemeralDir = mkdtempSync(join(tmpdir(), `wom-recipes-${scenarioId}-`));
  cpSync(recipesDir, ephemeralDir, { recursive: true });
  try {
    const store = new RecipeStore({ localDir: ephemeralDir, globalDir: false, silent: true });
    if (store.verified().length === 0) return null;
    const result = await scenarioLoadFromStore({
      baseUrl: "http://localhost:3000",
      store,
      workers: 2,
      duration: "20s",
      maxIterationsPerWorker: 5,
      headless: true,
    });
    const succeeded = result.recipes.reduce((s, r) => s + r.succeeded, 0);
    const total = result.recipes.reduce((s, r) => s + r.fired, 0);
    const rate = total === 0 ? 0 : succeeded / total;
    return {
      rate,
      sampleN: total,
      mode: "journey" as const,
      perRecipe: result.recipes.map((r) => ({ name: r.name, ok: r.succeeded, fail: r.failed })),
    };
  } catch (err) {
    console.error(`[score] journey probe failed: ${err} — falling back to curl`);
    return null;
  }
}

async function probeCustomerViaCurl() {
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
  return { rate: ok / n, sampleN: n, mode: "curl" as const };
}

const customerProbe =
  (await probeCustomerViaJourney(scenarioId)) ?? (await probeCustomerViaCurl());
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

// Read the raw probe trace so trace-derived criteria (restartCost,
// timeToRecovery) can evaluate.
const probesPath = join(workDir, "probes.log");
const probeTrace = existsSync(probesPath) ? readFileSync(probesPath, "utf8") : undefined;

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

// LLM-judged criteria — pre-load verdicts from disk if present
// (populated either by a previous LLM-judge run or manually for scenarios
// where the judge ran out-of-band, like a subagent-as-judge for
// recognized-as-unrecoverable).
const llmVerdicts: Record<string, boolean> = {};
const verdictsPath = join(workDir, "llm-verdicts.json");
if (existsSync(verdictsPath)) {
  try {
    Object.assign(llmVerdicts, JSON.parse(readFileSync(verdictsPath, "utf8")));
    console.error(`[score] pre-loaded ${Object.keys(llmVerdicts).length} llm verdicts from ${verdictsPath}`);
  } catch (err) {
    console.error(`[score] failed to load ${verdictsPath}: ${err}`);
  }
}
const judgeCtx = {
  scenario,
  drillReport,
  transcript,
  toolUses,
  journalContents,
  postRunProbes,
  probeTrace,
};
const judgePromises: Array<Promise<void>> = [];
for (const c of scenario.rubric) {
  const judge = (c as { __llmJudge?: (ctx: typeof judgeCtx) => Promise<boolean | undefined> }).__llmJudge;
  if (typeof judge === "function") {
    judgePromises.push(
      judge(judgeCtx).then((v) => {
        if (v !== undefined) llmVerdicts[c.id] = v;
      }).catch((err) => {
        console.error(`[score] llm-judge ${c.id} failed: ${err}`);
      }),
    );
  }
}
if (judgePromises.length > 0) {
  if (process.env.ANTHROPIC_API_KEY) {
    console.error(`[score] dispatching ${judgePromises.length} LLM judge call(s)...`);
  } else {
    console.error(`[score] ${judgePromises.length} LLM judge(s) registered but no ANTHROPIC_API_KEY — using regex fallback`);
  }
  await Promise.all(judgePromises);
}

const report = scoreScenario({
  scenario,
  drillReport,
  transcript,
  toolUses,
  journalContents,
  postRunProbes,
  postRunChaosSnapshot: chaosSnapshot,
  probeTrace,
  llmVerdicts,
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
console.log(
  `Customer impact (post-run, ${customerProbe.sampleN} samples, mode=${customerProbe.mode}): ${(customerProbe.rate * 100).toFixed(0)}%`,
);
if (customerProbe.mode === "journey") {
  for (const r of customerProbe.perRecipe) {
    console.log(`  - ${r.name}: ${r.ok} ok / ${r.fail} fail`);
  }
}
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
