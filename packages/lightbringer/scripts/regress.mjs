#!/usr/bin/env node
/**
 * Baseline-relative regression gate. Compares a baseline set of median reports
 * (<slug>.median.json) against the current set and fails when a metric got worse
 * by more than a relative threshold. This is the complement to per-span budgets:
 * budgets are absolute upper bounds you maintain by hand; this catches "the PR
 * made open-cart 35% slower" without anyone declaring a number.
 *
 * Produce a baseline (e.g. on main), then the current set (on the PR), each via:
 *   pnpm exec playwright test --repeat-each=5
 *   node scripts/median.mjs            # writes <slug>.median.json into PERF_OUT_DIR
 *
 * then compare:
 *   node scripts/regress.mjs <baselineDir> [currentDir] [--threshold=0.15]
 *
 * Defaults: currentDir = $PERF_OUT_DIR (or perf-results). Exits non-zero on any
 * hard regression. A metric whose median is noisy on either side (wide IQR) is
 * downgraded to a warning — the comparison can't be trusted, add runs.
 *
 * Every tracked metric is "lower is better", so a regression is an increase. Each
 * has an absolute floor so a 1ms→2ms swing isn't reported as "+100%".
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_REGRESS_THRESHOLD, formatRegress, regress } from "../dist/core.js";

// The comparison (thresholds, per-metric floors, noisy downgrade) lives in
// src/regress.ts, shared with chaosbringer's `perf regress`; this script only
// parses flags and reads <slug>.median.json files.

const args = process.argv.slice(2);
const flags = Object.fromEntries(
  args.filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
);
const positional = args.filter((a) => !a.startsWith("--"));
const baselineDir = positional[0];
const currentDir =
  positional[1] ?? process.env.PERF_OUT_DIR ?? "perf-results";
const threshold = flags.threshold != null ? Number(flags.threshold) : DEFAULT_REGRESS_THRESHOLD;

if (!baselineDir) {
  console.error(
    "usage: node scripts/regress.mjs <baselineDir> [currentDir] [--threshold=0.15]",
  );
  process.exit(1);
}
for (const d of [baselineDir, currentDir]) {
  if (!fs.existsSync(d)) {
    console.error(`directory not found: ${d}`);
    process.exit(1);
  }
}

function loadMedians(dir) {
  const out = new Map();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".median.json")) continue;
    const slug = f.replace(/\.median\.json$/, "");
    out.set(slug, JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  }
  return out;
}

const result = regress(loadMedians(baselineDir), loadMedians(currentDir), { threshold });
const { stdout, stderr, failed } = formatRegress(result, {
  baselineLabel: baselineDir,
  currentLabel: currentDir,
});
for (const line of stdout) console.log(line);
for (const line of stderr) console.error(line);
if (failed) process.exit(1);
