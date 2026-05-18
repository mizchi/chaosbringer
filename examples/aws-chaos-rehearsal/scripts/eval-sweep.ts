/**
 * eval-sweep.ts — run all replay fixtures and emit a comparison matrix (issue #116).
 *
 * The first useful slice of cross-agent comparison: every checked-in
 * fixture is one (scenario, agent, run) point. Naming convention so the
 * matrix groups sensibly: `<scenario-id>-<agent-or-mode>[-extra]`.
 * Examples:
 *   silent-data-loss-baseline               (canonical reference)
 *   silent-data-loss-claude-opus-47         (a future captured run)
 *   silent-data-loss-gpt-5                  (a future captured run)
 *   silent-data-loss-human-senior-sre       (a future captured run)
 *
 * When fixtures exist for the same scenario from different agents,
 * sweep groups them per-scenario in the matrix so a reader can compare
 * scores apples-to-apples.
 *
 * Usage:
 *   pnpm sweep                          — run all fixtures, print matrix to stdout
 *   pnpm sweep --report sweep.md        — write to file
 *   pnpm sweep --fail-on-regression     — exit non-zero if any fixture drifted
 *
 * Real-agent drivers (a subprocess that takes a brief + workdir and produces
 * a journal) are a planned follow-up — for now, every "agent" is a captured
 * fixture replayed deterministically. That makes the sweep cheap, no-API-key,
 * and CI-friendly.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const fixturesDir = resolve(import.meta.dirname, "..", "fixtures");
if (!existsSync(fixturesDir)) {
  console.error(`no fixtures dir at ${fixturesDir}`);
  process.exit(1);
}

let reportPath: string | undefined;
let failOnRegression = false;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a === "--report" && process.argv[i + 1]) {
    reportPath = process.argv[++i];
  } else if (a === "--fail-on-regression") {
    failOnRegression = true;
  } else if (a.startsWith("--report=")) {
    reportPath = a.slice("--report=".length);
  }
}

const fixtures = readdirSync(fixturesDir).filter((d) => {
  const p = join(fixturesDir, d);
  return statSync(p).isDirectory() && existsSync(join(p, "expected.json"));
});

interface Row {
  fixture: string;
  scenario: string;
  agent: string;
  expectedScore: number;
  actualScore: number | null;
  drift: number | null;
  status: "ok" | "regression" | "error";
  detail?: string;
}

function parseFixtureName(name: string): { scenario: string; agent: string } {
  // Convention: <scenario-id>-<agent-or-mode>[-extra]
  // We match the longest scenario-id prefix that resolves to a known scenario
  // by trial. Simpler heuristic: split on first occurrence of any known agent
  // keyword. For MVP, just take the first 3 hyphen segments as the scenario
  // and the rest as the agent label.
  const parts = name.split("-");
  // Known scenario ids tend to be 2-4 hyphenated tokens.
  // Try longest match first against the list of known scenarios.
  const knownScenarios = [
    "silent-data-loss",
    "duplicate-orders",
    "checkout-receipts-stalled",
    "credentials-revoked",
    "silent-credit-card-failures",
    "morning-rush-cognito",
    "compound-incident",
    "control-plane-degraded",
    "ddb-throttle-warmup",
    "ddb-dns-race",
    "misleading-chaos",
    "quota-saturated",
    "restart-trap",
    "tier-lookup-stampede",
    "no-hints-storm",
  ];
  for (const s of knownScenarios) {
    if (name === s || name.startsWith(s + "-")) {
      const agent = name.length > s.length ? name.slice(s.length + 1) : "baseline";
      return { scenario: s, agent };
    }
  }
  return { scenario: parts.slice(0, 3).join("-"), agent: parts.slice(3).join("-") || "baseline" };
}

const rows: Row[] = [];
for (const fixture of fixtures.sort()) {
  const expectedPath = join(fixturesDir, fixture, "expected.json");
  const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as {
    scenarioId: string;
    score: number;
  };
  const { agent } = parseFixtureName(fixture);
  const r = spawnSync("pnpm", ["replay", fixture], {
    encoding: "utf8",
    cwd: resolve(import.meta.dirname, ".."),
  });
  if (r.status !== 0) {
    // Parse the actual score out of stdout if present, otherwise null.
    const m = r.stdout?.match(/actual:\s+([\d.]+)%/);
    const actual = m ? Number(m[1]) / 100 : null;
    rows.push({
      fixture,
      scenario: expected.scenarioId,
      agent,
      expectedScore: expected.score,
      actualScore: actual,
      drift: actual !== null ? actual - expected.score : null,
      status: "regression",
      detail: extractDriftDetail(r.stdout ?? r.stderr ?? ""),
    });
    continue;
  }
  const m = r.stdout?.match(/actual:\s+([\d.]+)%/);
  const actual = m ? Number(m[1]) / 100 : expected.score;
  rows.push({
    fixture,
    scenario: expected.scenarioId,
    agent,
    expectedScore: expected.score,
    actualScore: actual,
    drift: actual - expected.score,
    status: "ok",
  });
}

const lines: string[] = [];
lines.push(`# AWS chaos rehearsal — sweep report`);
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push(`Fixtures: ${rows.length} across ${new Set(rows.map((r) => r.scenario)).size} scenarios`);
lines.push("");

// Group by scenario, sort rows by actual score descending.
const byScenario = new Map<string, Row[]>();
for (const row of rows) {
  const list = byScenario.get(row.scenario) ?? [];
  list.push(row);
  byScenario.set(row.scenario, list);
}

lines.push(`## Per-scenario`);
lines.push("");
for (const [scenario, group] of [...byScenario.entries()].sort()) {
  lines.push(`### ${scenario}`);
  lines.push("");
  lines.push("| Agent / fixture | Expected | Actual | Drift | Status |");
  lines.push("|---|---|---|---|---|");
  for (const row of group.sort((a, b) => (b.actualScore ?? 0) - (a.actualScore ?? 0))) {
    const expected = (row.expectedScore * 100).toFixed(1) + "%";
    const actual = row.actualScore !== null ? (row.actualScore * 100).toFixed(1) + "%" : "—";
    const drift =
      row.drift !== null
        ? (row.drift >= 0 ? "+" : "") + (row.drift * 100).toFixed(1) + "pp"
        : "—";
    const status =
      row.status === "ok" ? "ok" : row.status === "regression" ? "⚠ regression" : "error";
    lines.push(`| ${row.agent} | ${expected} | ${actual} | ${drift} | ${status} |`);
  }
  lines.push("");
}

const out = lines.join("\n");
if (reportPath) {
  writeFileSync(reportPath, out);
  console.log(`wrote ${reportPath}`);
} else {
  console.log(out);
}

const hasRegression = rows.some((r) => r.status === "regression");
if (hasRegression && failOnRegression) {
  console.error(`\nfail: ${rows.filter((r) => r.status === "regression").length} fixture(s) regressed.`);
  process.exit(1);
}

function extractDriftDetail(output: string): string {
  const m = output.match(/drift:.+?\(tolerance[^)]+\)/);
  return m?.[0] ?? "see replay output";
}
