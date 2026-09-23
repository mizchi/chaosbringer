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

const DIR = path.resolve(process.env.PERF_OUT_DIR ?? "perf-results");

const round = (n) => Math.round(n * 10) / 10;

/** Nearest-rank percentile (p in 0..1) of a sorted array. */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.round((sorted.length - 1) * p);
  return sorted[i];
}

function median(values) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

// A robust summary: median with an IQR band (p25..p75), so a single bad run does
// not blow up the reported spread the way min..max does. `noisy` flags a median
// that's too unstable to trust (wide IQR relative to the median) — increase runs
// or don't gate on it. Small medians are never flagged (relative spread is moot).
function stat(values) {
  const s = [...values].sort((a, b) => a - b);
  const med = median(values);
  const p25 = round(percentile(s, 0.25));
  const p75 = round(percentile(s, 0.75));
  const noisy = med > 5 && (p75 - p25) / med > 0.25;
  return {
    median: med,
    p25,
    p75,
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
    noisy,
    n: values.length,
  };
}

function statBy(items, selector) {
  return stat(items.map(selector));
}

function aggregateSlug(slug, runs) {
  const vitalNames = new Set();
  for (const r of runs) for (const k of Object.keys(r.vitals)) vitalNames.add(k);
  const vitals = {};
  for (const name of vitalNames) {
    const vals = runs
      .map((r) => r.vitals[name]?.value)
      .filter((v) => typeof v === "number");
    if (vals.length) vitals[name] = stat(vals);
  }

  const spanNames = [];
  for (const r of runs)
    for (const s of r.spans)
      if (!spanNames.includes(s.name)) spanNames.push(s.name);
  const spans = spanNames.map((name) => {
    const items = runs.flatMap((r) => r.spans.filter((s) => s.name === name));
    const budget = items.find((s) => s.budget)?.budget;
    const hasPaint = items.some((s) => s.render?.paintCount !== undefined);
    const render = {
      recalcStyleCount: statBy(items, (s) => s.render?.recalcStyleCount ?? 0),
      recalcStyleMs: statBy(items, (s) => s.render?.recalcStyleMs ?? 0),
      layoutCount: statBy(items, (s) => s.render?.layoutCount ?? 0),
      layoutMs: statBy(items, (s) => s.render?.layoutMs ?? 0),
      nodes: statBy(items, (s) => s.render?.nodes ?? 0),
      scriptMs: statBy(items, (s) => s.render?.scriptMs ?? 0),
    };
    if (hasPaint) {
      render.paintCount = statBy(items, (s) => s.render?.paintCount ?? 0);
      render.paintMs = statBy(items, (s) => s.render?.paintMs ?? 0);
      render.gpuMs = statBy(items, (s) => s.render?.gpuMs ?? 0);
    }
    const hasMemory = items.some((s) => s.memory !== undefined);
    const memory = hasMemory
      ? {
          jsHeapUsedMB: statBy(items, (s) => s.memory?.jsHeapUsedMB ?? 0),
          jsHeapDeltaMB: statBy(items, (s) => s.memory?.jsHeapDeltaMB ?? 0),
          arrayBuffers: statBy(items, (s) => s.memory?.arrayBuffers ?? 0),
          domNodes: statBy(items, (s) => s.memory?.domNodes ?? 0),
          jsEventListeners: statBy(items, (s) => s.memory?.jsEventListeners ?? 0),
          listenersDelta: statBy(items, (s) => s.memory?.listenersDelta ?? 0),
          documentsDelta: statBy(items, (s) => s.memory?.documentsDelta ?? 0),
        }
      : undefined;
    return {
      name,
      durationMs: statBy(items, (s) => s.durationMs),
      network: {
        busyMs: statBy(items, (s) => s.network.busyMs),
        waves: statBy(items, (s) => s.network.waves ?? 0),
        encodedKB: statBy(items, (s) => s.network.encodedKB),
        requestCount: statBy(items, (s) => s.network.requestCount),
        thirdPartyKB: statBy(items, (s) => s.network.thirdParty?.encodedKB ?? 0),
        thirdPartyRequestCount: statBy(
          items,
          (s) => s.network.thirdParty?.requestCount ?? 0,
        ),
      },
      cpu: {
        blockingMs: statBy(items, (s) => s.cpu.blockingMs),
        maxLongTaskMs: statBy(items, (s) => s.cpu.maxLongTaskMs),
      },
      render,
      memory,
      interaction: items.some((s) => s.interaction)
        ? {
            maxDurationMs: statBy(items, (s) => s.interaction?.maxDurationMs ?? 0),
            inputDelayMs: statBy(items, (s) => s.interaction?.inputDelayMs ?? 0),
            processingMs: statBy(items, (s) => s.interaction?.processingMs ?? 0),
            presentationMs: statBy(items, (s) => s.interaction?.presentationMs ?? 0),
          }
        : undefined,
      frames: items.some((s) => s.frames)
        ? {
            droppedFrames: statBy(items, (s) => s.frames?.droppedFrames ?? 0),
            longestFrameMs: statBy(items, (s) => s.frames?.longestFrameMs ?? 0),
            fps: statBy(items, (s) => s.frames?.fps ?? 0),
          }
        : undefined,
      budget,
    };
  });

  const appNames = [];
  for (const r of runs)
    for (const s of r.appSpans ?? [])
      if (!appNames.includes(s.name)) appNames.push(s.name);
  const appSpans = appNames.map((name) => {
    const items = runs.flatMap((r) =>
      (r.appSpans ?? []).filter((s) => s.name === name),
    );
    return {
      name,
      occurrences: items.length,
      durationMs: statBy(items, (s) => s.durationMs),
      network: { busyMs: statBy(items, (s) => s.network.busyMs) },
      cpu: { blockingMs: statBy(items, (s) => s.cpu.blockingMs) },
    };
  });

  const vitalsBudget = runs.find((r) => r.vitalsBudget)?.vitalsBudget;
  return { slug, runs: runs.length, vitals, vitalsBudget, spans, appSpans };
}

// median with an IQR band; "!" marks a noisy (unstable) median.
function fmt(s) {
  return `${s.median} (${s.p25}..${s.p75})${s.noisy ? " !noisy" : ""}`;
}

// budget field -> aggregated stat accessor
const STAT_OF = {
  durationMs: (s) => s.durationMs,
  scriptMs: (s) => s.render.scriptMs,
  blockingMs: (s) => s.cpu.blockingMs,
  encodedKB: (s) => s.network.encodedKB,
  requestCount: (s) => s.network.requestCount,
  waves: (s) => s.network.waves,
  busyMs: (s) => s.network.busyMs,
  thirdPartyKB: (s) => s.network.thirdPartyKB,
  thirdPartyRequestCount: (s) => s.network.thirdPartyRequestCount,
  layoutCount: (s) => s.render.layoutCount,
  recalcStyleMs: (s) => s.render.recalcStyleMs,
  recalcStyleCount: (s) => s.render.recalcStyleCount,
  nodes: (s) => s.render.nodes,
  paintMs: (s) => s.render.paintMs, // only present with PERF_TRACE
  paintCount: (s) => s.render.paintCount,
  gpuMs: (s) => s.render.gpuMs, // only present with PERF_TRACE
  jsHeapUsedMB: (s) => s.memory?.jsHeapUsedMB,
  jsHeapDeltaMB: (s) => s.memory?.jsHeapDeltaMB,
  listenersDelta: (s) => s.memory?.listenersDelta,
  interactionMs: (s) => s.interaction?.maxDurationMs,
  droppedFrames: (s) => s.frames?.droppedFrames,
  longestFrameMs: (s) => s.frames?.longestFrameMs,
};

/**
 * Budget check against the median (robust to outliers). Returns hard violations
 * (median > budget) plus soft warnings for noisy metrics whose IQR straddles the
 * budget — the gate could flip run-to-run, so increase --repeat-each before trusting it.
 */
function checkBudget(agg) {
  const violations = [];
  const warnings = [];
  for (const s of agg.spans) {
    if (!s.budget) continue;
    for (const [k, limit] of Object.entries(s.budget)) {
      if (limit == null || !STAT_OF[k]) continue;
      const st = STAT_OF[k](s);
      if (!st) continue; // e.g. paint metrics absent without PERF_TRACE
      if (st.median > limit) {
        violations.push(`${agg.slug} / ${s.name}.${k} median=${st.median} > budget ${limit}`);
      } else if (st.noisy && st.p75 > limit) {
        warnings.push(
          `${agg.slug} / ${s.name}.${k} median=${st.median} <= ${limit} but noisy (p75=${st.p75}) — gate may be flaky, add runs`,
        );
      }
    }
  }
  if (agg.vitalsBudget) {
    for (const [k, limit] of Object.entries(agg.vitalsBudget)) {
      const st = agg.vitals[k];
      if (limit == null || !st) continue;
      if (st.median > limit) {
        violations.push(`${agg.slug} / vitals.${k} median=${st.median} > budget ${limit}`);
      } else if (st.noisy && st.p75 > limit) {
        warnings.push(
          `${agg.slug} / vitals.${k} median=${st.median} <= ${limit} but noisy (p75=${st.p75})`,
        );
      }
    }
  }
  return { violations, warnings };
}

function printSummary(agg) {
  const lines = [`\n[median] ${agg.slug}  (${agg.runs} runs)`];
  const v = agg.vitals;
  const vfmt = (name) => (v[name] ? fmt(v[name]) : "n/a");
  lines.push(
    `  vitals  LCP=${vfmt("LCP")}  INP=${vfmt("INP")}  CLS=${vfmt("CLS")}  TTFB=${vfmt("TTFB")}`,
  );
  for (const s of agg.spans) {
    lines.push(`  ${s.name}  ${fmt(s.durationMs)}ms`);
    const saturated =
      s.durationMs.median > 50 &&
      s.network.busyMs.median / s.durationMs.median > 0.9;
    lines.push(
      `      net    busy=${fmt(s.network.busyMs)}ms  reqs=${fmt(s.network.requestCount)}  waves=${fmt(s.network.waves)}  ${fmt(s.network.encodedKB)}KB` +
        (saturated ? "  (net-saturated: busyMs ≈ window)" : ""),
    );
    if (s.network.thirdPartyRequestCount && s.network.thirdPartyRequestCount.median > 0) {
      lines.push(
        `      3p     reqs=${fmt(s.network.thirdPartyRequestCount)}  ${fmt(s.network.thirdPartyKB)}KB`,
      );
    }
    lines.push(
      `      cpu    block=${fmt(s.cpu.blockingMs)}ms  maxTask=${fmt(s.cpu.maxLongTaskMs)}ms`,
    );
    if (s.interaction) {
      lines.push(
        `      inp    ${fmt(s.interaction.maxDurationMs)}ms  (input ${fmt(s.interaction.inputDelayMs)} / proc ${fmt(s.interaction.processingMs)} / present ${fmt(s.interaction.presentationMs)})`,
      );
    }
    if (s.frames && (s.frames.droppedFrames.median > 0 || s.frames.longestFrameMs.median > 33)) {
      lines.push(
        `      frames ${fmt(s.frames.fps)}fps  dropped=${fmt(s.frames.droppedFrames)}  longest=${fmt(s.frames.longestFrameMs)}ms`,
      );
    }
    const r = s.render;
    const paint = r.paintCount
      ? `  paint=${fmt(r.paintCount)}/${fmt(r.paintMs)}ms  gpu=${fmt(r.gpuMs)}ms`
      : "";
    lines.push(
      `      render style=${fmt(r.recalcStyleCount)}/${fmt(r.recalcStyleMs)}ms  layout=${fmt(r.layoutCount)}/${fmt(r.layoutMs)}ms  nodes=${fmt(r.nodes)}  script=${fmt(r.scriptMs)}ms${paint}`,
    );
    if (s.memory) {
      const m = s.memory;
      lines.push(
        `      mem    heap=${fmt(m.jsHeapUsedMB)}MB  Δheap=${fmt(m.jsHeapDeltaMB)}MB  arraybufs=${fmt(m.arrayBuffers)}  listeners=${fmt(m.jsEventListeners)} (Δ${fmt(m.listenersDelta)})`,
      );
    }
  }
  if (agg.appSpans.length) {
    lines.push("  app spans (performance.measure):");
    for (const s of agg.appSpans) {
      lines.push(
        `    ${s.name} x${s.occurrences}  ${fmt(s.durationMs)}ms  net=${fmt(s.network.busyMs)}ms  cpu=${fmt(s.cpu.blockingMs)}ms`,
      );
    }
  }
  console.log(lines.join("\n"));
}

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
    const agg = aggregateSlug(slug, runs);
    fs.writeFileSync(
      path.join(DIR, `${slug}.median.json`),
      JSON.stringify(agg, null, 2),
    );
    printSummary(agg);
    const r = checkBudget(agg);
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
