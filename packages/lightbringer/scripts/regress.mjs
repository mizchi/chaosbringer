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

const round = (n) => Math.round(n * 10) / 10;

const args = process.argv.slice(2);
const flags = Object.fromEntries(
  args.filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
);
const positional = args.filter((a) => !a.startsWith("--"));
const baselineDir = positional[0];
const currentDir =
  positional[1] ?? process.env.PERF_OUT_DIR ?? "perf-results";
const threshold = Number(flags.threshold ?? "0.15");

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

// metric -> { label, get(span) => stat | undefined, floor } (floor in metric units).
// A regression requires BOTH median > baseline*(1+threshold) AND the absolute
// delta >= floor, so small-magnitude metrics don't trip on relative noise.
const SPAN_METRICS = [
  { key: "durationMs", label: "durationMs", get: (s) => s.durationMs, floor: 5 },
  { key: "scriptMs", label: "render.scriptMs", get: (s) => s.render?.scriptMs, floor: 2 },
  { key: "blockingMs", label: "cpu.blockingMs", get: (s) => s.cpu?.blockingMs, floor: 5 },
  { key: "busyMs", label: "network.busyMs", get: (s) => s.network?.busyMs, floor: 10 },
  { key: "encodedKB", label: "network.encodedKB", get: (s) => s.network?.encodedKB, floor: 10 },
  { key: "requestCount", label: "network.requestCount", get: (s) => s.network?.requestCount, floor: 1 },
  { key: "waves", label: "network.waves", get: (s) => s.network?.waves, floor: 1 },
  { key: "thirdPartyKB", label: "network.thirdPartyKB", get: (s) => s.network?.thirdPartyKB, floor: 10 },
  { key: "layoutCount", label: "render.layoutCount", get: (s) => s.render?.layoutCount, floor: 5 },
  { key: "recalcStyleMs", label: "render.recalcStyleMs", get: (s) => s.render?.recalcStyleMs, floor: 2 },
  { key: "nodes", label: "render.nodes", get: (s) => s.render?.nodes, floor: 50 },
  { key: "gpuMs", label: "render.gpuMs", get: (s) => s.render?.gpuMs, floor: 2 },
  { key: "paintCount", label: "render.paintCount", get: (s) => s.render?.paintCount, floor: 10 },
  { key: "jsHeapUsedMB", label: "memory.jsHeapUsedMB", get: (s) => s.memory?.jsHeapUsedMB, floor: 1 },
  { key: "jsEventListeners", label: "memory.jsEventListeners", get: (s) => s.memory?.jsEventListeners, floor: 10 },
  { key: "interactionMs", label: "interaction.maxDurationMs", get: (s) => s.interaction?.maxDurationMs, floor: 16 },
  { key: "droppedFrames", label: "frames.droppedFrames", get: (s) => s.frames?.droppedFrames, floor: 2 },
  { key: "longestFrameMs", label: "frames.longestFrameMs", get: (s) => s.frames?.longestFrameMs, floor: 16 },
];

const VITAL_METRICS = [
  { key: "LCP", floor: 50 },
  { key: "INP", floor: 20 },
  { key: "CLS", floor: 0.01 },
  { key: "TTFB", floor: 20 },
  { key: "FCP", floor: 50 },
];

function loadMedians(dir) {
  const out = new Map();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".median.json")) continue;
    const slug = f.replace(/\.median\.json$/, "");
    out.set(slug, JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  }
  return out;
}

const pct = (base, cur) => (base === 0 ? (cur > 0 ? Infinity : 0) : (cur - base) / base);
function fmtPct(p) {
  if (p === Infinity) return "new";
  const s = Math.round(p * 100);
  return `${s >= 0 ? "+" : ""}${s}%`;
}

/**
 * Classify one metric comparison.
 *   regression: worse than gate AND past the floor -> hard fail (unless noisy)
 *   improvement: better than gate AND past the floor -> info
 *   noisy: would-regress but the IQR is unstable on either side -> warn only
 */
function classify(baseStat, curStat, floor) {
  if (!baseStat || !curStat) return null;
  const base = baseStat.median;
  const cur = curStat.median;
  const delta = cur - base;
  const p = pct(base, cur);
  const noisy = baseStat.noisy || curStat.noisy;
  const worse = p > threshold && delta >= floor;
  const better = p < -threshold && -delta >= floor;
  if (worse) return { kind: noisy ? "noisy" : "regression", base, cur, p, delta };
  if (better) return { kind: "improvement", base, cur, p, delta };
  return { kind: "ok", base, cur, p, delta };
}

const baseMedians = loadMedians(baselineDir);
const curMedians = loadMedians(currentDir);

console.log(
  `\n[regress] baseline ${baselineDir}  vs  current ${currentDir}  (gate: +${Math.round(threshold * 100)}%)`,
);

const regressions = [];
const warnings = [];
let improvements = 0;

for (const [slug, cur] of curMedians) {
  const base = baseMedians.get(slug);
  if (!base) {
    console.log(`\n  ${slug}  (no baseline — skipped)`);
    continue;
  }
  const lines = [];
  // spans matched by name
  for (const curSpan of cur.spans) {
    const baseSpan = base.spans.find((s) => s.name === curSpan.name);
    if (!baseSpan) {
      lines.push(`    span "${curSpan.name}" is new (no baseline)`);
      continue;
    }
    for (const m of SPAN_METRICS) {
      const r = classify(m.get(baseSpan), m.get(curSpan), m.floor);
      if (!r || r.kind === "ok") continue;
      const mark =
        r.kind === "regression" ? "✗" : r.kind === "noisy" ? "~" : "✓";
      const line = `    ${curSpan.name} / ${m.label}  ${round(r.base)} → ${round(r.cur)}  (${fmtPct(r.p)})  ${mark}`;
      lines.push(line);
      if (r.kind === "regression") regressions.push(`${slug} / ${curSpan.name}.${m.label} ${round(r.base)} → ${round(r.cur)} (${fmtPct(r.p)})`);
      else if (r.kind === "noisy") warnings.push(`${slug} / ${curSpan.name}.${m.label} ${round(r.base)} → ${round(r.cur)} (${fmtPct(r.p)}) — noisy, can't gate`);
      else improvements++;
    }
  }
  // vitals
  for (const m of VITAL_METRICS) {
    const r = classify(base.vitals?.[m.key], cur.vitals?.[m.key], m.floor);
    if (!r || r.kind === "ok") continue;
    const mark = r.kind === "regression" ? "✗" : r.kind === "noisy" ? "~" : "✓";
    lines.push(`    vitals.${m.key}  ${round(r.base)} → ${round(r.cur)}  (${fmtPct(r.p)})  ${mark}`);
    if (r.kind === "regression") regressions.push(`${slug} / vitals.${m.key} ${round(r.base)} → ${round(r.cur)} (${fmtPct(r.p)})`);
    else if (r.kind === "noisy") warnings.push(`${slug} / vitals.${m.key} ${round(r.base)} → ${round(r.cur)} (${fmtPct(r.p)}) — noisy`);
    else improvements++;
  }
  if (lines.length) console.log(`\n  ${slug}\n${lines.join("\n")}`);
}

console.log("");
if (improvements > 0) console.log(`  ✓ ${improvements} improvement(s)`);
if (warnings.length > 0) {
  console.log(`\n[regress] noisy (warn only, ${warnings.length}):`);
  for (const w of warnings) console.log(`  ~ ${w}`);
}
if (regressions.length > 0) {
  console.error(`\n[regress] REGRESSIONS (${regressions.length}):`);
  for (const r of regressions) console.error(`  ✗ ${r}`);
  process.exit(1);
}
console.log("\n[regress] no regressions past the gate.");
