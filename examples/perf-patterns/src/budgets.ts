/**
 * `chaosbringer perf emit-budgets` and `perf gate` over a pattern's crawl
 * reports, through the CLI a user runs: budgets emitted from the fixed
 * variant must let a fresh fixed run pass, and must still fail the slow one
 * on the pattern's metric, so the default floors do not hide what the
 * catalog exists to catch.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CrawlReport } from "chaosbringer";

const CLI = fileURLToPath(new URL("./cli.js", import.meta.resolve("chaosbringer")));

/**
 * A pattern's metric path → the metric emit-budgets writes a budget for. A
 * metric missing here (`page.*`, `network.settledMs`, `memory.*`, …) has no
 * emitted budget, so the gate cannot fail on it.
 */
export const EMITTED_BUDGET_METRIC: Readonly<Record<string, string>> = {
  durationMs: "durationMs",
  "render.scriptMs": "scriptMs",
  "cpu.blockingMs": "blockingMs",
  "render.layoutCount": "layoutCount",
  "render.recalcStyleMs": "recalcStyleMs",
  "network.encodedKB": "encodedKB",
  "network.requestCount": "requestCount",
  "interaction.maxDurationMs": "interactionMs",
};

export interface GateFinding {
  scope: string;
  metric: string;
  median: number;
  limit: number;
}

/** `perf gate --json`'s output, and its exit code. */
export interface GateOutcome {
  exitCode: number;
  passed: boolean;
  violations: GateFinding[];
  warnings: GateFinding[];
}

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) =>
    execFile(process.execPath, [CLI, ...args], { timeout: 60_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout, stderr }),
    ),
  );
}

/** A scratch dir for one pattern's reports and budgets; `dispose` removes it. */
export function budgetsWorkdir(id: string): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `perf-patterns-budgets-${id}-`));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeReports(dir: string, name: string, reports: readonly CrawlReport[]): string[] {
  return reports.map((r, i) => {
    const p = join(dir, `${name}-${i + 1}.json`);
    writeFileSync(p, JSON.stringify(r));
    return p;
  });
}

/**
 * `perf emit-budgets` with the default floors, and the default headroom
 * unless `headroom` is given; the budgets file's path.
 */
export async function emitBudgetsCli(
  dir: string,
  reports: readonly CrawlReport[],
  { headroom, name = "budgets" }: { headroom?: number; name?: string } = {},
): Promise<string> {
  const out = join(dir, `${name}.json`);
  const args = ["perf", "emit-budgets", ...writeReports(dir, `${name}-base`, reports), "--out", out];
  if (headroom !== undefined) args.push("--headroom", String(headroom));
  const r = await run(args);
  if (r.code !== 0) throw new Error(`perf emit-budgets exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`);
  return out;
}

/**
 * Whether every finding's budget was set by the headroom term,
 * ceil(median × headroom), rather than by the floor term, ceil(median +
 * floor). With `--headroom 1` emit-budgets writes the floor term alone, so a
 * budget above that one is the headroom's.
 */
export async function headroomSetAll(
  dir: string,
  reports: readonly CrawlReport[],
  findings: readonly GateFinding[],
): Promise<boolean> {
  const floorOnly = JSON.parse(
    readFileSync(await emitBudgetsCli(dir, reports, { headroom: 1, name: "floor-only" }), "utf-8"),
  ) as { budgets: Record<string, Record<string, number>> };
  return findings.every((f) => {
    const floorTerm = floorOnly.budgets[f.scope]?.[f.metric];
    return floorTerm !== undefined && f.limit > floorTerm;
  });
}

/** `perf gate --json` of `reports` (their medians) against a budgets file. */
export async function gateCli(dir: string, name: string, reports: readonly CrawlReport[], budgets: string): Promise<GateOutcome> {
  const r = await run(["perf", "gate", ...writeReports(dir, name, reports), "--budgets", budgets, "--json"]);
  // 0 passed, 1 failed; anything else is the CLI refusing the call.
  if (r.code !== 0 && r.code !== 1) throw new Error(`perf gate exited ${r.code}: ${r.stderr.trim()}`);
  const out = JSON.parse(r.stdout) as Omit<GateOutcome, "exitCode">;
  return { exitCode: r.code, passed: out.passed, violations: out.violations, warnings: out.warnings };
}
