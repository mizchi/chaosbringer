import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// Environment-driven configuration for the collector. Every knob is a PERF_*
// env var resolved once at module load. Kept in one place so the capture,
// controller, report, and session layers share the same source of truth.
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
// web-vitals' attribution iife declares `var webVitals = ...` at top level.
// addInitScript runs inside a function wrapper, so the var never reaches window.
// We append an explicit assignment so it is available at document-start.
// The deep iife path is not in web-vitals' "exports", so resolve the package
// main and locate the iife next to it.
export const WEB_VITALS_IIFE =
  fs.readFileSync(
    path.join(
      path.dirname(require.resolve("web-vitals")),
      "web-vitals.attribution.iife.js",
    ),
    "utf8",
  ) + "\n;globalThis.webVitals=webVitals;";

export const PERF_OUT_DIR = path.resolve(process.env.PERF_OUT_DIR ?? "perf-results");

/**
 * PERF_CSS=1 adds the `disabled-by-default-blink.debug` trace category, which
 * makes Blink emit per-selector match stats (SelectorStats) on every style
 * recalc — so the drilldown can show WHICH selectors cost the recalc time. It's
 * expensive (instruments every match attempt), so it's opt-in and implies a trace.
 */
export const CSS_STATS = process.env.PERF_CSS === "1";

/**
 * PERF_COV=1 records JS + CSS coverage across the whole scenario
 * (resetOnNavigation: false) via Playwright's Chromium coverage API. It reveals
 * how much of each downloaded chunk / stylesheet the scenario actually used —
 * low usage means the chunk is split too coarsely or shipped needlessly. Across
 * scenarios, scripts/coverage.mjs unions the used ranges to find code no scenario
 * touched (dead-code / over-shipping candidates). Chromium-only; expensive.
 */
export const COV_ENABLED = process.env.PERF_COV === "1";

/** With PERF_TRACE=1 (or PERF_CSS=1), save a Chrome trace (openable in DevTools / Perfetto). */
export const TRACE_ENABLED = process.env.PERF_TRACE === "1" || CSS_STATS;

/** PERF_CPU=N throttles the CPU N times (mid-tier device emulation). 1 = off. */
export const CPU_RATE = Number(process.env.PERF_CPU ?? "1");

/**
 * PERF_MEM=1 forces a GC (HeapProfiler.collectGarbage) at each span boundary so
 * the memory deltas reflect *retained* memory — the leak signal — instead of
 * not-yet-collected garbage from the step itself. Off by default because the GC
 * adds wall time to the span (it would distort durationMs / settle timing).
 */
export const MEM_GC = process.env.PERF_MEM === "1";

/** Max time to wait for settle before marking a span capped (ms). */
export const SETTLE_TIMEOUT_MS = Number(process.env.PERF_SETTLE_TIMEOUT ?? "5000");

/**
 * PERF_NET selects a network emulation profile via CDP. Throughput in bytes/s,
 * latency in ms. Approximate DevTools-style presets.
 */
const NET_PROFILES: Record<
  string,
  { latency: number; downloadThroughput: number; uploadThroughput: number }
> = {
  "slow-3g": { latency: 400, downloadThroughput: 51_200, uploadThroughput: 51_200 },
  "fast-3g": { latency: 150, downloadThroughput: 196_608, uploadThroughput: 98_304 },
  "4g": { latency: 40, downloadThroughput: 1_179_648, uploadThroughput: 589_824 },
};
export const NET_PROFILE = NET_PROFILES[process.env.PERF_NET ?? ""];
