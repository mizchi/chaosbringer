/**
 * `chaosbringer diff <left.json> <right.json>` — compare two independent
 * crawl reports and surface cluster / page differences.
 *
 * Distinct from `--baseline`, which assumes the left is "yesterday's
 * good run" and the right is "today's run". The standalone subcommand
 * is symmetric: it shows left-only, right-only, and shared clusters
 * without claiming a direction. Designed for the dual-runtime
 * regression workflow described in #88 — same site data, two runtimes,
 * separate which clusters are unique to each side from the ones in both.
 * In that workflow a cluster in both is caused by neither runtime: it is
 * third-party noise, or a bug both share.
 *
 * The heavy lifting (cluster matching, page state computation) lives
 * in `diffReports` so behaviour stays consistent with `--baseline`.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { UsageError } from "./cli-usage.js";
import { diffReports } from "./diff.js";
import type { CrawlReport } from "./types.js";

function loadReport(path: string): CrawlReport {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`failed to read ${path}: ${err instanceof Error ? err.message : err}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`failed to parse ${path}: ${err instanceof Error ? err.message : err}`);
  }
  const report = parsed as CrawlReport;
  if (!report || typeof report !== "object" || !Array.isArray(report.errorClusters)) {
    throw new Error(`${path} is not a chaos report (no errorClusters array)`);
  }
  return report;
}

interface DiffSummary {
  left: string;
  right: string;
  /** `sample` is one raw message of the cluster; the key holds its normalised fingerprint. */
  leftOnlyClusters: Array<{ key: string; type: string; count: number; sample?: string }>;
  rightOnlyClusters: Array<{ key: string; type: string; count: number; sample?: string }>;
  sharedClusters: Array<{ key: string; type: string; leftCount: number; rightCount: number; sample?: string }>;
  leftOnlyFailedPages: Array<{ url: string; errors: number }>;
  rightOnlyFailedPages: Array<{ url: string; errors: number }>;
}

/**
 * Reframe `diffReports` from the symmetric two-runtime perspective.
 *
 * `diffReports(baseline, current)` calls things `new` / `resolved`
 * relative to the baseline. For two-runtime diffing we don't have a
 * baseline — we want "only on left", "only on right", "on both". The
 * mapping:
 *
 *   - newClusters       — in right, not in left   → rightOnly
 *   - resolvedClusters  — in left,  not in right  → leftOnly
 *   - unchangedClusters — in both                 → shared
 *
 * Same logic applies to failed pages.
 */
function buildSummary(leftPath: string, rightPath: string): DiffSummary {
  const left = loadReport(leftPath);
  const right = loadReport(rightPath);
  const d = diffReports(left, right);
  const sampleOf = (report: CrawlReport, key: string) =>
    report.errorClusters.find((c) => c.key === key)?.sample?.message;
  return {
    left: leftPath,
    right: rightPath,
    leftOnlyClusters: d.resolvedClusters.map((c) => ({
      key: c.key,
      type: c.type,
      count: c.before,
      sample: sampleOf(left, c.key),
    })),
    rightOnlyClusters: d.newClusters.map((c) => ({
      key: c.key,
      type: c.type,
      count: c.after,
      sample: sampleOf(right, c.key),
    })),
    sharedClusters: d.unchangedClusters.map((c) => ({
      key: c.key,
      type: c.type,
      leftCount: c.before,
      rightCount: c.after,
      sample: sampleOf(left, c.key) ?? sampleOf(right, c.key),
    })),
    leftOnlyFailedPages: d.resolvedFailedPages
      .filter((p) => p.before !== null)
      .map((p) => ({ url: p.url, errors: p.before!.errors })),
    rightOnlyFailedPages: d.newFailedPages.map((p) => ({
      url: p.url,
      errors: p.after?.errors ?? 0,
    })),
  };
}

/** Samples longer than this are cut in the human summary; `--json` has them whole. */
const SAMPLE_SHOWN = 160;

/**
 * A cluster's raw sample, under its line, when it says more than the key:
 * the fingerprint replaces URLs and numbers with `<url>` / `<n>`, so
 * `Failed to load <url>` does not say which file.
 */
function sampleLine(c: { key: string; sample?: string }): string[] {
  const first = c.sample?.split("\n")[0]?.trim();
  if (!first || c.key.endsWith(`|${first}`)) return [];
  return [`      e.g. ${first.length > SAMPLE_SHOWN ? `${first.slice(0, SAMPLE_SHOWN - 1)}…` : first}`];
}

function formatHuman(s: DiffSummary): string {
  const out: string[] = [];
  out.push(`Comparing:`);
  out.push(`  left  = ${s.left}`);
  out.push(`  right = ${s.right}`);
  out.push("");
  out.push(`Clusters: ${s.leftOnlyClusters.length} left-only, ${s.rightOnlyClusters.length} right-only, ${s.sharedClusters.length} shared`);
  out.push(`Pages:    ${s.leftOnlyFailedPages.length} failed only on left, ${s.rightOnlyFailedPages.length} only on right`);
  out.push("");
  if (s.leftOnlyClusters.length > 0) {
    out.push("Left-only clusters:");
    for (const c of s.leftOnlyClusters) {
      out.push(`  [${c.type}] ${c.key} (${c.count})`, ...sampleLine(c));
    }
    out.push("");
  }
  if (s.rightOnlyClusters.length > 0) {
    out.push("Right-only clusters:");
    for (const c of s.rightOnlyClusters) {
      out.push(`  [${c.type}] ${c.key} (${c.count})`, ...sampleLine(c));
    }
    out.push("");
  }
  if (s.sharedClusters.length > 0) {
    // It said "likely third-party noise", which is what a shared cluster is
    // in the two-runtime workflow (see HELP) and not in general: the app's
    // own `fixture: boom` exception, on both sides, was listed under it.
    out.push("Shared (both sides):");
    for (const c of s.sharedClusters) {
      out.push(`  [${c.type}] ${c.key} (left=${c.leftCount}, right=${c.rightCount})`, ...sampleLine(c));
    }
    out.push("");
  }
  if (s.leftOnlyFailedPages.length > 0) {
    out.push("Pages failing only on left:");
    for (const p of s.leftOnlyFailedPages) {
      out.push(`  ${p.url} (${p.errors} errors)`);
    }
    out.push("");
  }
  if (s.rightOnlyFailedPages.length > 0) {
    out.push("Pages failing only on right:");
    for (const p of s.rightOnlyFailedPages) {
      out.push(`  ${p.url} (${p.errors} errors)`);
    }
    out.push("");
  }
  return out.join("\n");
}

const HELP = `Usage: chaosbringer diff <left.json> <right.json> [options]

Compare two independent crawl reports. Shows clusters that appear only
on the left, only on the right, and on both sides, with a raw sample
message where it says more than the normalised key. When the two reports
are one site served by two runtimes and crawled with the same seed, a
shared cluster is not caused by either runtime: third-party noise, or a
bug both have.

Options:
  --json                Output JSON instead of a human-readable summary
  --shared-only         Print only the shared clusters
  --left-only           Print only the left-only clusters/pages
  --right-only          Print only the right-only clusters/pages
  --help                Show this help

Examples:
  chaosbringer diff old.json new.json
  chaosbringer diff runtime-a.json runtime-b.json --json > diff.json
  chaosbringer diff a.json b.json --right-only  # show what's broken only on the right
`;

export async function runDiffCli(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      "shared-only": { type: "boolean", default: false },
      "left-only": { type: "boolean", default: false },
      "right-only": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (positionals.length !== 2) {
    throw new UsageError(`expected exactly two report paths, got ${positionals.length}`);
  }
  const [leftPath, rightPath] = positionals;
  const summary = buildSummary(leftPath, rightPath);

  if (values.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  // Filtered views — useful for piping into wrapper scripts that only
  // care about one side. Filters are exclusive: enabling one suppresses
  // the others.
  if (values["shared-only"]) {
    for (const c of summary.sharedClusters) {
      console.log(`[${c.type}] ${c.key} (left=${c.leftCount}, right=${c.rightCount})`);
    }
    return;
  }
  if (values["left-only"]) {
    for (const c of summary.leftOnlyClusters) console.log(`[${c.type}] ${c.key} (${c.count})`);
    for (const p of summary.leftOnlyFailedPages) console.log(`PAGE ${p.url} (${p.errors} errors)`);
    return;
  }
  if (values["right-only"]) {
    for (const c of summary.rightOnlyClusters) console.log(`[${c.type}] ${c.key} (${c.count})`);
    for (const p of summary.rightOnlyFailedPages) console.log(`PAGE ${p.url} (${p.errors} errors)`);
    return;
  }

  console.log(formatHuman(summary));
}
