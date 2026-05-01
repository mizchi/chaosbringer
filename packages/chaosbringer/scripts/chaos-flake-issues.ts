/**
 * Reconcile open `chaos-flake` issues against a fresh flake report.
 *
 *   pnpm tsx scripts/chaos-flake-issues.ts <flake.json>
 *
 * Each flaky cluster (fired in some but not all runs, runsWithCluster >= 2)
 * gets one open issue. Issues are matched by an embedded marker:
 *
 *   <!-- chaos-flake-key: <cluster.key> -->
 *
 * Issues for clusters that no longer appear are closed with a comment.
 *
 * Required env: GH_TOKEN (or auth via gh CLI), GH_REPO (owner/name).
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

interface ClusterOccurrence {
  key: string;
  type: string;
  fingerprint: string;
  perRunCounts: number[];
  runsWithCluster: number;
}

interface FlakeAnalysis {
  runs: number;
  stableClusters: ClusterOccurrence[];
  flakyClusters: ClusterOccurrence[];
  flakyPages: { url: string; failedInRuns: number; visitedInRuns: number }[];
  durations: number[];
}

const LABEL = "chaos-flake";
const MIN_RUNS_WITH_CLUSTER = 2;

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("usage: chaos-flake-issues.ts <flake.json>");
  process.exit(2);
}

const repo = process.env.GH_REPO;
if (!repo) {
  console.error("GH_REPO must be set (owner/name)");
  process.exit(2);
}

function gh(args: string[], input?: string): string {
  return execFileSync("gh", args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  });
}

function ensureLabel(): void {
  try {
    gh(["label", "create", LABEL, "-R", repo!, "--description", "Auto-managed by chaos-flake workflow", "--color", "FBCA04", "--force"]);
  } catch {
    // ignore — label exists or creation failed for harmless reasons
  }
}

function markerFor(key: string): string {
  return `<!-- chaos-flake-key: ${key} -->`;
}

function buildBody(c: ClusterOccurrence, runs: number): string {
  const fired = c.runsWithCluster;
  const counts = c.perRunCounts.join(", ");
  return [
    markerFor(c.key),
    "",
    `Auto-managed by \`.github/workflows/chaos-flake.yml\`. Do not edit body — it is overwritten on the next run.`,
    "",
    `**Type:** \`${c.type}\``,
    `**Fingerprint:** \`${c.fingerprint}\``,
    `**Fired in:** ${fired} / ${runs} runs`,
    `**Per-run counts:** \`[${counts}]\``,
    "",
    `Reproduce locally:`,
    "",
    "```",
    `pnpm exec chaosbringer flake --url <fixture-url> --runs ${runs} --output flake.json`,
    "```",
  ].join("\n");
}

function listOpenFlakeIssues(): { number: number; title: string; body: string }[] {
  const out = gh(["issue", "list", "-R", repo!, "--label", LABEL, "--state", "open", "--limit", "200", "--json", "number,title,body"]);
  return JSON.parse(out);
}

function findExisting(issues: ReturnType<typeof listOpenFlakeIssues>, key: string): number | undefined {
  const marker = markerFor(key);
  return issues.find((i) => i.body.includes(marker))?.number;
}

function main() {
  const analysis = JSON.parse(readFileSync(inputPath!, "utf8")) as FlakeAnalysis;
  const flaky = analysis.flakyClusters.filter((c) => c.runsWithCluster >= MIN_RUNS_WITH_CLUSTER);
  const seenKeys = new Set(flaky.map((c) => c.key));

  ensureLabel();
  const open = listOpenFlakeIssues();

  let opened = 0;
  let updated = 0;
  let closed = 0;

  for (const c of flaky) {
    const title = `[chaos-flake] ${c.type}: ${c.fingerprint.slice(0, 80)}`;
    const body = buildBody(c, analysis.runs);
    const existing = findExisting(open, c.key);
    if (existing) {
      gh(["issue", "edit", String(existing), "-R", repo!, "--body", body, "--title", title]);
      updated++;
    } else {
      gh(["issue", "create", "-R", repo!, "--title", title, "--body", body, "--label", LABEL]);
      opened++;
    }
  }

  for (const issue of open) {
    const match = issue.body.match(/<!-- chaos-flake-key: (.+?) -->/);
    if (!match) continue;
    const key = match[1];
    if (seenKeys.has(key)) continue;
    gh(["issue", "comment", String(issue.number), "-R", repo!, "--body", "Cluster no longer appears in the latest flake report. Closing automatically."]);
    gh(["issue", "close", String(issue.number), "-R", repo!]);
    closed++;
  }

  console.log(`opened=${opened} updated=${updated} closed=${closed}`);
}

main();
