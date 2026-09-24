#!/usr/bin/env node
/**
 * Drill down into one span: aggregate the trace within the span window to find
 * which subsystem / function spends CPU. A generic way to locate the cause of a
 * span's CPU cost.
 *
 * Requires PERF_TRACE=1 so that <slug>.run<idx>.json and <slug>.run<idx>.trace.json
 * both exist (span.traceWindowUs is matched against the trace).
 *
 * Usage:
 *   PERF_TRACE=1 pnpm exec playwright test
 *   node scripts/drilldown.mjs <slug> <spanName> [run=0] [topN=15]
 *
 * Output: total RunTask time in the span window, an event-name breakdown (which
 * subsystem), and a function-level breakdown (functionName @ url:line).
 */
import fs from "node:fs";
import path from "node:path";
import { analyseDrilldown, formatDrilldown } from "../dist/core.js";

// The analysis (window filtering, CPU-profiler self time, first/third party,
// GPU, initiators, selector cost) lives in src/drilldown.ts, shared with
// chaosbringer's `perf drilldown`; this script only reads the two files.

const DIR = path.resolve(process.env.PERF_OUT_DIR ?? "perf-results");

function die(msg) {
  console.error(msg);
  process.exit(1);
}

const [, , slug, spanName, runArg, topArg] = process.argv;
if (!slug || !spanName) {
  die("usage: node scripts/drilldown.mjs <slug> <spanName> [run] [topN]");
}
const run = runArg ?? "0";
const topN = Number(topArg ?? 15);

const reportPath = path.join(DIR, `${slug}.run${run}.json`);
const tracePath = path.join(DIR, `${slug}.run${run}.trace.json`);
if (!fs.existsSync(reportPath)) die(`not found: ${reportPath}`);
if (!fs.existsSync(tracePath))
  die(`not found: ${tracePath} (measured with PERF_TRACE=1?)`);

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const span = report.spans.find((s) => s.name === spanName);
if (!span) {
  die(
    `span "${spanName}" not found. candidates: ${report.spans.map((s) => s.name).join(", ")}`,
  );
}
const events = JSON.parse(fs.readFileSync(tracePath, "utf8"));

const analysis = analyseDrilldown(span, events, { pageUrl: report.url, topN });
for (const line of formatDrilldown(analysis, { slug, spanName })) console.log(line);
