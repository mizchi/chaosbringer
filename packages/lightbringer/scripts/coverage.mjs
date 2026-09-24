#!/usr/bin/env node
/**
 * Union JS/CSS coverage across every scenario run to find code that NO scenario
 * used — dead-code / over-shipping candidates — and to judge whether chunks are
 * split well (a chunk the whole E2E suite barely touches is split too coarsely or
 * shipped needlessly).
 *
 * Each PERF_COV=1 run writes <slug>.run<idx>.coverage.json (per-url used byte
 * ranges). This merges them: a byte is "used" if ANY scenario executed it.
 *
 * Usage:
 *   PERF_COV=1 pnpm exec playwright test       # run the whole suite
 *   node scripts/coverage.mjs [--min=30]        # union; flag urls under --min% used
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_COVERAGE_MIN_PCT, formatCoverageUnion, unionCoverage } from "../dist/core.js";

// The union and its classification live in src/coverage-union.ts; this script
// only reads the artifacts.

const DIR = path.resolve(process.env.PERF_OUT_DIR ?? "perf-results");
const flags = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => a.replace(/^--/, "").split("=")),
);
const minPct = flags.min != null ? Number(flags.min) : DEFAULT_COVERAGE_MIN_PCT;

if (!fs.existsSync(DIR)) {
  console.error(`${DIR} not found. Run the suite with PERF_COV=1 first.`);
  process.exit(1);
}
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".coverage.json"));
if (files.length === 0) {
  console.error("No coverage artifacts (<slug>.coverage.json). Run with PERF_COV=1.");
  process.exit(1);
}

const artifacts = files.map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")));
for (const line of formatCoverageUnion(unionCoverage(artifacts), { runs: files.length, minPct }))
  console.log(line);
