#!/usr/bin/env node
/**
 * Aggregate multiple run reports (perf-results/<slug>.run*.json) into a median
 * with min..max per span / app span / vital.
 *
 * Usage:
 *   pnpm exec playwright test --repeat-each=5
 *   node scripts/median.mjs            # aggregate all slugs
 *   node scripts/median.mjs <slug>     # aggregate one slug
 *
 * A single run is noisy (JIT / cache / GC), so use the median for regression
 * checks and before/after comparisons. min..max is the noise band — how far you
 * can trust the number.
 */
import fs from "node:fs";
import path from "node:path";
import { aggregateRuns, checkMedianBudgets, formatMedianSummary } from "../dist/core.js";

const DIR = path.resolve(process.env.PERF_OUT_DIR ?? "perf-results");

// The statistics (median with a p25..p75 band, the noisy flag) and the budget
// gate live in src/stats.ts, shared with `lightbringer run --gate` and
// chaosbringer's `perf` subcommands; this script only does the file I/O.

function main() {
  if (!fs.existsSync(DIR)) {
    console.error(`${DIR} not found. Run the playwright tests first.`);
    process.exit(1);
  }
  const filter = process.argv[2];
  const files = fs
    .readdirSync(DIR)
    .filter((f) => /\.run\d+\.json$/.test(f) && !f.includes(".trace."));

  const bySlug = new Map();
  for (const f of files) {
    const slug = f.replace(/\.run\d+\.json$/, "");
    if (filter && slug !== filter) continue;
    (bySlug.get(slug) ?? bySlug.set(slug, []).get(slug)).push(f);
  }

  if (bySlug.size === 0) {
    console.error("No run reports found (<slug>.run*.json).");
    process.exit(1);
  }

  const violations = [];
  const warnings = [];
  for (const [slug, runFiles] of bySlug) {
    const runs = runFiles.map((f) =>
      JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")),
    );
    const agg = aggregateRuns(slug, runs);
    fs.writeFileSync(
      path.join(DIR, `${slug}.median.json`),
      JSON.stringify(agg, null, 2),
    );
    console.log(formatMedianSummary(agg));
    const r = checkMedianBudgets(agg);
    violations.push(...r.violations);
    warnings.push(...r.warnings);
  }

  if (warnings.length > 0) {
    console.error(`\n[median] noisy budget metrics (${warnings.length}):`);
    for (const w of warnings) console.error(`  ~ ${w}`);
  }
  if (violations.length > 0) {
    console.error(`\n[median] BUDGET EXCEEDED (${violations.length}):`);
    for (const v of violations) console.error(`  ! ${v}`);
    process.exit(1);
  }
}

main();
