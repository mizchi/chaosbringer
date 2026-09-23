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

const DIR = path.resolve(process.env.PERF_OUT_DIR ?? "perf-results");

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function round(n) {
  return Math.round(n * 10) / 10;
}

function shorten(url) {
  return url.replace(/^https?:\/\/[^/]+/, "").slice(0, 70);
}

// First- vs third-party by registrable domain (mirrors src/collector.ts).
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "gov.uk", "ac.uk", "org.uk", "co.jp", "ne.jp", "or.jp", "go.jp",
  "ac.jp", "co.kr", "co.in", "co.nz", "co.za", "com.au", "com.br", "com.cn",
  "com.tw", "com.hk", "com.sg", "com.mx",
]);
function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
function registrableDomain(host) {
  if (!host || host.includes(":")) return host;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(last2) ? parts.slice(-3).join(".") : last2;
}
function domainOf(url) {
  const h = hostOf(url);
  return h ? registrableDomain(h) : null;
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
const [startUs, endUs] = span.traceWindowUs;
const events = JSON.parse(fs.readFileSync(tracePath, "utf8"));

// The page's own registrable domain: app frames from any other domain are
// third-party (analytics, tag managers, embedded widgets).
const firstPartyDomain = domainOf(report.url);

const inWindow = events.filter(
  (e) => e.ph === "X" && e.ts != null && e.ts >= startUs && e.ts <= endUs,
);

const tasks = inWindow
  .filter((e) => e.name === "RunTask")
  .map((e) => e.dur / 1000);
const taskTotal = tasks.reduce((a, d) => a + d, 0);
const longTasks = tasks.filter((d) => d >= 50).sort((a, b) => b - a);

// event-name breakdown: which subsystem is heavy (RunTask excluded as a container)
const byName = new Map();
for (const e of inWindow) {
  if (!e.name || e.name === "RunTask" || e.dur == null) continue;
  const cur = byName.get(e.name) ?? { totalMs: 0, count: 0 };
  cur.totalMs += e.dur / 1000;
  cur.count += 1;
  byName.set(e.name, cur);
}
const nameRanked = [...byName.entries()]
  .map(([name, v]) => ({ name, totalMs: round(v.totalMs), count: v.count }))
  .sort((a, b) => b.totalMs - a.totalMs)
  .slice(0, 12);

// function-level breakdown (FunctionCall / EvaluateScript)
const byFn = new Map();
for (const e of inWindow) {
  const d = e.args?.data;
  if (!d) continue;
  let key;
  if (e.name === "FunctionCall") {
    const fn = d.functionName || "(anonymous)";
    const loc = d.url ? `${shorten(d.url)}:${d.lineNumber ?? "?"}` : "";
    key = `${fn}  ${loc}`;
  } else if (e.name === "EvaluateScript" || e.name === "v8.compile") {
    key = `(eval) ${shorten(d.url || "")}`;
  } else {
    continue;
  }
  const cur = byFn.get(key) ?? { totalMs: 0, count: 0 };
  cur.totalMs += e.dur / 1000;
  cur.count += 1;
  byFn.set(key, cur);
}
const fnRanked = [...byFn.entries()]
  .map(([key, v]) => ({ key, totalMs: round(v.totalMs), count: v.count }))
  .sort((a, b) => b.totalMs - a.totalMs)
  .slice(0, topN);

// --- self time from the V8 CPU profiler (disabled-by-default-v8.cpu_profiler) ---
// ProfileChunk events carry incrementally-defined call-tree nodes plus a sample
// stream (node id per sample) and timeDeltas (μs between samples). Self time of a
// node = sum of timeDeltas for samples landing on it. Unlike the function totals
// above (which include children), this is each frame's own cost.
// Known harness frames: Playwright's injected actionability/visibility helpers
// (no script URL) and lightbringer's own in-page collector. Used to separate
// measurement overhead from real app/library self time (frames that have a URL).
const HARNESS_NAMES = new Set([
  "getComputedStyle",
  "getElementComputedStyle",
  "isElementStyleVisibilityVisible",
  "isVisible",
  "elementState",
  "processElement",
  "getCSSContent",
  "visit",
  "oneLine",
  "generateSelector",
  "querySelectorAll",
  "ariaSnapshot",
  "getTextAlternativeInternal",
  "getExplicitAriaRole",
  "getImplicitAriaRole",
  "belongsToDisplayNoneOrAriaHiddenOrNonSlotted",
  "InjectedScript",
  "browserCollector",
  "drainLongTask",
  "drainLoaf",
  "drainMeasure",
]);

const nodeFrame = new Map(); // nodeId -> { label, kind, party } | null
const selfByFrame = new Map(); // label -> { ms, kind, party }
const selfByKind = { app: 0, harness: 0, native: 0 };
// Of the app (has-URL) self time, how much is first- vs third-party script.
const selfByParty = { first: 0, third: 0 };
const selfByDomain = new Map(); // third-party domain -> self ms
let profileStartUs = null;
let cursorUs = null;

for (const e of events) {
  if (e.name === "Profile" && e.args?.data?.startTime != null) {
    profileStartUs = e.args.data.startTime;
    cursorUs = profileStartUs;
  }
  if (e.name !== "ProfileChunk") continue;
  const cp = e.args?.data?.cpuProfile;
  if (!cp) continue;
  for (const n of cp.nodes ?? []) {
    const cf = n.callFrame ?? {};
    const fn = cf.functionName || "(anonymous)";
    // skip V8 synthetic frames so the ranking shows real JS, not idle/GC time
    if (["(idle)", "(program)", "(garbage collector)", "(root)"].includes(fn)) {
      nodeFrame.set(n.id, null);
      continue;
    }
    // app = has a script URL; harness = known injected/collector name; native = rest
    const kind = cf.url ? "app" : HARNESS_NAMES.has(fn) ? "harness" : "native";
    const loc = cf.url ? `${shorten(cf.url)}:${(cf.lineNumber ?? 0) + 1}` : "";
    // For app frames, split first- vs third-party by the script URL's domain.
    const domain = kind === "app" ? domainOf(cf.url) : null;
    const party =
      kind === "app" && firstPartyDomain
        ? domain === firstPartyDomain
          ? "first"
          : "third"
        : null;
    nodeFrame.set(n.id, { label: `${fn}  ${loc}`, kind, party, domain });
  }
  const samples = cp.samples ?? [];
  const deltas = e.args.data.timeDeltas ?? cp.timeDeltas ?? [];
  if (cursorUs == null) cursorUs = profileStartUs ?? startUs;
  for (let i = 0; i < samples.length; i++) {
    const dt = deltas[i] ?? 0;
    cursorUs += dt;
    if (cursorUs < startUs || cursorUs > endUs) continue;
    const frame = nodeFrame.get(samples[i]);
    if (!frame) continue;
    const cur =
      selfByFrame.get(frame.label) ??
      { ms: 0, kind: frame.kind, party: frame.party, domain: frame.domain };
    cur.ms += dt / 1000;
    selfByFrame.set(frame.label, cur);
    selfByKind[frame.kind] += dt / 1000;
    if (frame.party) selfByParty[frame.party] += dt / 1000;
    if (frame.party === "third" && frame.domain) {
      selfByDomain.set(frame.domain, (selfByDomain.get(frame.domain) ?? 0) + dt / 1000);
    }
  }
}
const selfRanked = [...selfByFrame.entries()]
  .map(([key, v]) => ({ key, selfMs: round(v.ms), kind: v.kind, party: v.party }))
  .filter((r) => r.selfMs > 0)
  .sort((a, b) => b.selfMs - a.selfMs)
  .slice(0, topN);

// Third-party CPU rolled up per script domain — the "weight" non-app scripts emit.
const domainRanked = [...selfByDomain.entries()]
  .map(([domain, ms]) => ({ domain, selfMs: round(ms) }))
  .filter((r) => r.selfMs > 0)
  .sort((a, b) => b.selfMs - a.selfMs);

console.log(`\n[drilldown] ${slug}`);
console.log(
  `span "${spanName}"  dur=${span.durationMs}ms  cpu.block=${span.cpu.blockingMs}ms  render.script=${span.render.scriptMs}ms`,
);
console.log(
  `  RunTask total ${round(taskTotal)}ms / ${tasks.length} tasks` +
    `  (long tasks >=50ms: ${longTasks.map((d) => round(d) + "ms").join(", ") || "none"})`,
);
console.log(`\n  event-name total time (which subsystem):`);
for (const r of nameRanked) {
  console.log(`    ${String(r.totalMs).padStart(8)}ms x${r.count}  ${r.name}`);
}
console.log(`\n  function total time top ${topN} (includes children):`);
if (fnRanked.length === 0) {
  console.log(
    "    no matching events (v8.execute category may be missing from the trace)",
  );
}
for (const r of fnRanked) {
  console.log(`    ${String(r.totalMs).padStart(8)}ms x${r.count}  ${r.key}`);
}

console.log(
  `\n  function SELF time top ${topN} (own cost, from CPU profiler):` +
    `  [app ${round(selfByKind.app)}ms / harness ${round(selfByKind.harness)}ms / native ${round(selfByKind.native)}ms]`,
);
if (firstPartyDomain) {
  console.log(
    `    app self split: first-party ${round(selfByParty.first)}ms` +
      ` / third-party ${round(selfByParty.third)}ms  (page domain: ${firstPartyDomain})`,
  );
}
if (selfRanked.length === 0) {
  console.log(
    "    no CPU profiler samples in window (was PERF_TRACE=1 with v8.cpu_profiler?)",
  );
}
for (const r of selfRanked) {
  const tag = r.party === "third" ? "  [3p]" : r.kind === "app" ? "" : `  [${r.kind}]`;
  console.log(`    ${String(r.selfMs).padStart(8)}ms  ${r.key}${tag}`);
}

if (domainRanked.length > 0) {
  console.log(`\n  third-party CPU by domain (self time the app didn't author):`);
  for (const r of domainRanked) {
    console.log(`    ${String(r.selfMs).padStart(8)}ms  ${r.domain}`);
  }
}

// --- GPU rendering load (GPU process, not the main thread) ---
// GPUTask events are the GPU process's work units; raster / image-decode / paint
// run there off the main thread, so a span can be cheap on CPU yet GPU-bound.
// These come from the `gpu` + devtools.timeline.frame trace categories.
const GPU_NAMES = new Set([
  "GPUTask",
  "RasterTask",
  "ImageDecodeTask",
  "Rasterize",
  "RasterFinishedTask",
]);
const byGpu = new Map();
let gpuTotal = 0;
for (const e of inWindow) {
  if (!e.name || e.dur == null || !GPU_NAMES.has(e.name)) continue;
  const cur = byGpu.get(e.name) ?? { totalMs: 0, count: 0 };
  cur.totalMs += e.dur / 1000;
  cur.count += 1;
  byGpu.set(e.name, cur);
  if (e.name === "GPUTask") gpuTotal += e.dur / 1000;
}
const gpuRanked = [...byGpu.entries()]
  .map(([name, v]) => ({ name, totalMs: round(v.totalMs), count: v.count }))
  .sort((a, b) => b.totalMs - a.totalMs);
console.log(
  `\n  GPU rendering load (GPU process):  GPUTask total ${round(gpuTotal)}ms` +
    `  (render.gpu=${span.render?.gpuMs ?? "n/a"}ms)`,
);
if (gpuRanked.length === 0) {
  console.log(
    "    no GPU events in window (software GL / SwiftShader emits none — use PERF_GPU=1)",
  );
}
for (const r of gpuRanked) {
  console.log(`    ${String(r.totalMs).padStart(8)}ms x${r.count}  ${r.name}`);
}

// --- network initiators (which code issued this span's requests) ---
// From the report (CDP Network.requestWillBeSent.initiator), so it needs no trace.
// The network-side analogue of the CPU self-time: when waves is deep, this names
// the code (or parser) responsible for the waterfall.
const initiators = span.network?.byInitiator ?? [];
if (initiators.length > 0) {
  console.log(
    `\n  network initiators (who issued the ${span.network.requestCount} requests, ${span.network.waves} waves):`,
  );
  for (const it of initiators) {
    console.log(
      `    ${String(it.requestCount).padStart(4)} reqs  ${String(it.encodedKB).padStart(7)}KB  ${it.frame}  [${it.type}]`,
    );
  }
}

// --- image decode cost (GPU/CPU spent turning bytes into bitmaps) ---
const DECODE_NAMES = new Set(["Decode Image", "ImageDecodeTask", "Decode LazyPixelRef"]);
let decodeMs = 0;
let decodeCount = 0;
for (const e of inWindow) {
  if (e.dur == null || !DECODE_NAMES.has(e.name)) continue;
  decodeMs += e.dur / 1000;
  decodeCount += 1;
}
if (decodeCount > 0) {
  console.log(
    `\n  image decode: ${round(decodeMs)}ms across ${decodeCount} decodes (oversized images cost more to decode)`,
  );
}

// --- CSS selector match cost (why style recalc is expensive) ---
// SelectorStats events (disabled-by-default-blink.debug, i.e. PERF_CSS=1) carry
// per-selector match stats for each recalc. Aggregating elapsed time names the
// selectors that cost the recalc; match_attempts with match_count 0 are wasteful
// selectors (re-tested against the DOM on every recalc but never match).
const selAgg = new Map();
for (const e of events) {
  if (e.name !== "SelectorStats") continue;
  if (e.ts != null && (e.ts < startUs || e.ts > endUs)) continue;
  const timings = e.args?.selector_stats?.selector_timings ?? [];
  for (const t of timings) {
    const key = t.selector;
    const cur = selAgg.get(key) ?? { us: 0, attempts: 0, rejects: 0, matches: 0 };
    cur.us += t["elapsed (us)"] ?? 0;
    cur.attempts += t.match_attempts ?? 0;
    cur.rejects += t.fast_reject_count ?? 0;
    cur.matches += t.match_count ?? 0;
    selAgg.set(key, cur);
  }
}
if (selAgg.size > 0) {
  const all = [...selAgg.entries()].map(([selector, v]) => ({ selector, ...v }));
  const totalUs = all.reduce((a, s) => a + s.us, 0);
  console.log(
    `\n  CSS selector match cost (${selAgg.size} selectors, ${round(totalUs / 1000)}ms total matching):`,
  );
  console.log(
    `    note: PERF_CSS instruments every match attempt, so the recalc TIME is inflated` +
      ` (this run's recalc=${span.render?.recalcStyleMs ?? "n/a"}ms). Use this to find WHICH` +
      ` selectors; read recalcStyleMs from a normal run for the real magnitude.`,
  );
  const bySlow = [...all].sort((a, b) => b.us - a.us).slice(0, topN);
  console.log(`    slowest selectors (match time):`);
  for (const s of bySlow) {
    console.log(
      `      ${String(round(s.us / 1000)).padStart(7)}ms  attempts=${s.attempts}  matches=${s.matches}  ${s.selector}`,
    );
  }
  // wasteful = many attempts, never matched -> dead weight on every recalc
  const wasteful = all
    .filter((s) => s.matches === 0 && s.attempts > 0)
    .sort((a, b) => b.attempts - a.attempts)
    .slice(0, topN);
  if (wasteful.length > 0) {
    console.log(`    wasteful selectors (attempts, never matched — candidates to delete/scope):`);
    for (const s of wasteful) {
      console.log(
        `      ${String(s.attempts).padStart(7)} attempts  ${round(s.us / 1000)}ms  ${s.selector}`,
      );
    }
  }
} else if (span.render?.recalcStyleMs > 0) {
  console.log(
    `\n  CSS selector match cost: no SelectorStats in window (run with PERF_CSS=1 to see per-selector cost)`,
  );
}
