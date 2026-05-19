/**
 * promote-fixture.ts — turn a successful eval run into a CI fixture (#120).
 *
 * Usage:
 *   pnpm promote-fixture <scenario-id> <run-id> [<fixture-name>]
 *
 * Reads /tmp/wom-<run-id>/{journal,probes.log,transcript.txt,report.json}
 * and the LIVE kumo /kumo/chaos/rules snapshot (to capture full rule
 * shapes — report.json only has stats). Writes a complete fixture under
 * examples/aws-chaos-rehearsal/fixtures/<fixture-name>/:
 *
 *   journal.md           (verbatim from the run)
 *   probes.log           (verbatim from the run)
 *   transcript.txt       (verbatim if present; falls back to journal)
 *   _replay-inputs.json  (customerProbe + postRunProbes + full chaosSnapshot)
 *   llm-verdicts.json    (per-criterion outcomes from report.json)
 *   expected.json        (canonical score + criteria pass/fail)
 *
 * Default fixture name is "<scenario-id>-baseline".
 *
 * Assumes kumo is currently running with the scenario's chaos rules
 * installed (so it can read the full rule shapes). For best results,
 * run this IMMEDIATELY after pnpm score, before re-installing other
 * chaos rules.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";

const scenarioId = process.argv[2];
const runId = process.argv[3];
const fixtureName = process.argv[4] ?? `${scenarioId}-baseline`;

if (!scenarioId || !runId) {
  console.error("usage: pnpm promote-fixture <scenario-id> <run-id> [<fixture-name>]");
  process.exit(64);
}

const workDir = `/tmp/wom-${runId}`;
const fixtureDir = resolve(import.meta.dirname, "..", "fixtures", fixtureName);

if (!existsSync(workDir)) {
  console.error(`no run dir at ${workDir}`);
  process.exit(1);
}

const reportPath = join(workDir, "report.json");
if (!existsSync(reportPath)) {
  console.error(`no report.json — has \`pnpm score ${scenarioId} ${runId}\` been run?`);
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
  scenarioId: string;
  score: number;
  passed: boolean;
  criteria: { id: string; passed: boolean; weight: number }[];
  customerProbe: { rate: number; sampleN: number };
  chaosStats: { ruleId: string; matched: number; skipped: number; recentTraces?: string[] }[];
};

// Fetch LIVE chaos rules (the full shape, not just stats) so the
// replay can reconstruct the chaosSnapshot accurately. If kumo
// isn't reachable, fall back to an empty rules list — the replay
// won't pass `chaosRulesPreserved` but everything else will work.
async function fetchKumoSnapshot(): Promise<{ rules: unknown[]; stats: unknown[] }> {
  try {
    const r = await fetch("http://localhost:4566/kumo/chaos/rules", { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return { rules: [], stats: report.chaosStats };
    return (await r.json()) as { rules: unknown[]; stats: unknown[] };
  } catch {
    return { rules: [], stats: report.chaosStats };
  }
}
const kumo = await fetchKumoSnapshot();

mkdirSync(fixtureDir, { recursive: true });

// Verbatim copies.
for (const name of ["journal.md", "probes.log", "transcript.txt"]) {
  const src = join(workDir, name);
  if (existsSync(src)) {
    copyFileSync(src, join(fixtureDir, name));
  } else if (name === "transcript.txt") {
    // Fallback: synthesize transcript from journal (eval-replay
    // already does this internally, but explicit is better than
    // implicit for fixtures).
    copyFileSync(join(workDir, "journal.md"), join(fixtureDir, "transcript.txt"));
  }
}

// _replay-inputs.json: customer probe + per-criterion async probes + chaos snapshot.
// postRunProbes are reconstructed from criteria that take probe values
// (customer-impact-recovered always; no-silent-data-loss / no-new-duplicates if PASS).
const postRunProbes: Record<string, { rate: number; sampleN: number }> = {
  "customer-impact-recovered": report.customerProbe,
};
const passById = new Map(report.criteria.map((c) => [c.id, c.passed]));
if (passById.has("no-silent-data-loss")) {
  postRunProbes["no-silent-data-loss"] = { rate: passById.get("no-silent-data-loss") ? 1 : 0, sampleN: 5 };
}
if (passById.has("no-new-duplicates")) {
  postRunProbes["no-new-duplicates"] = { rate: passById.get("no-new-duplicates") ? 1 : 0, sampleN: 5 };
}

writeFileSync(
  join(fixtureDir, "_replay-inputs.json"),
  JSON.stringify({
    customerProbe: report.customerProbe,
    postRunProbes,
    chaosSnapshot: { rules: kumo.rules ?? [], stats: report.chaosStats },
  }, null, 2),
);

// llm-verdicts.json: per-criterion pass/fail so the replay is offline.
writeFileSync(
  join(fixtureDir, "llm-verdicts.json"),
  JSON.stringify(Object.fromEntries(report.criteria.map((c) => [c.id, c.passed])), null, 2),
);

// expected.json: canonical outcome.
writeFileSync(
  join(fixtureDir, "expected.json"),
  JSON.stringify({
    scenarioId: report.scenarioId,
    score: report.score,
    passed: report.passed,
    criteria: report.criteria.map((c) => ({ id: c.id, passed: c.passed })),
  }, null, 2),
);

console.log(`wrote fixture: ${fixtureDir}`);
console.log(`  scenario: ${report.scenarioId}`);
console.log(`  score:    ${(report.score * 100).toFixed(1)}%`);
console.log(`  rules:    ${(kumo.rules as unknown[]).length}`);
console.log(`  criteria: ${report.criteria.filter((c) => c.passed).length}/${report.criteria.length} pass`);
console.log();
console.log(`Verify with: pnpm replay ${fixtureName}`);
