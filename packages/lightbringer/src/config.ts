import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { SessionOptions } from "./session";
import { DEFAULT_SETTLE_TIMEOUT_MS, netProfileByName, type NetProfile } from "./defaults";

// ---------------------------------------------------------------------------
// Configuration edges. Nothing here reads the environment or the filesystem at
// import time: the core takes its options as arguments (SessionOptions), and only
// the runner edges (the @playwright/test fixture, the auto fixture, the CLI) call
// sessionOptionsFromEnv() to map PERF_* env vars onto those options.
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);

let webVitalsCache: string | undefined;

/**
 * The web-vitals attribution IIFE, resolved on first use and cached.
 *
 * web-vitals' attribution iife declares `var webVitals = ...` at top level.
 * addInitScript runs inside a function wrapper, so the var never reaches window.
 * We append an explicit assignment so it is available at document-start.
 * The deep iife path is not in web-vitals' "exports", so resolve the package
 * main and locate the iife next to it.
 */
export function webVitalsIife(): string {
  if (webVitalsCache === undefined) {
    webVitalsCache =
      fs.readFileSync(
        path.join(
          path.dirname(require.resolve("web-vitals")),
          "web-vitals.attribution.iife.js",
        ),
        "utf8",
      ) + "\n;globalThis.webVitals=webVitals;";
  }
  return webVitalsCache;
}

/** What sessionOptionsFromEnv resolves: SessionOptions plus the edge-only knobs. */
export type EnvSessionOptions = SessionOptions & {
  /** PERF_OUT_DIR (default ./perf-results), resolved against cwd */
  outDir: string;
  /** PERF_CPU=N throttles the CPU N times (mid-tier device emulation). 1 = off. */
  cpuRate: number;
  /** PERF_NET=slow-3g|fast-3g|4g, or null */
  netProfile: NetProfile | null;
  /**
   * PERF_CSS=1 adds the `disabled-by-default-blink.debug` trace category, which
   * makes Blink emit per-selector match stats (SelectorStats) on every style
   * recalc. Expensive, so opt-in; implies a trace.
   */
  cssStats: boolean;
  /** PERF_TRACE=1 (or PERF_CSS=1): save a Chrome trace (DevTools / Perfetto). */
  trace: boolean;
  /**
   * PERF_COV=1 records JS + CSS coverage across the whole scenario
   * (resetOnNavigation: false). Chromium-only; expensive.
   */
  coverage: boolean;
  /**
   * PERF_MEM=1 forces a GC (HeapProfiler.collectGarbage) at each span boundary so
   * memory deltas reflect *retained* memory. Off by default: the GC adds wall time.
   */
  memGc: boolean;
  /** PERF_SETTLE_TIMEOUT (ms, default 5000) */
  settleTimeoutMs: number;
  /** PERF_ASSERT=1 fails the test inline on a budget violation */
  assert: boolean;
};

/**
 * Map PERF_* env vars onto session options. The single env edge: only the
 * fixture / auto fixture / CLI call this; the core never reads the environment.
 */
export function sessionOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): EnvSessionOptions {
  const cssStats = env.PERF_CSS === "1";
  return {
    outDir: path.resolve(env.PERF_OUT_DIR ?? "perf-results"),
    cpuRate: Number(env.PERF_CPU ?? "1"),
    netProfile: netProfileByName(env.PERF_NET),
    cssStats,
    trace: env.PERF_TRACE === "1" || cssStats,
    coverage: env.PERF_COV === "1",
    memGc: env.PERF_MEM === "1",
    settleTimeoutMs: Number(env.PERF_SETTLE_TIMEOUT ?? String(DEFAULT_SETTLE_TIMEOUT_MS)),
    assert: env.PERF_ASSERT === "1",
  };
}

/**
 * The SessionOptions subset the runner edges derive from their resolved knobs
 * (env for the test fixtures, flags for the CLI). Every key is always passed,
 * as the edges' literals did before this was shared.
 */
export function toSessionOptions(
  o: Pick<
    EnvSessionOptions,
    "cpuRate" | "netProfile" | "cssStats" | "trace" | "coverage" | "memGc" | "settleTimeoutMs"
  >,
  tracePath: string,
): SessionOptions {
  return {
    cpuRate: o.cpuRate,
    netProfile: o.netProfile,
    cssStats: o.cssStats,
    trace: o.trace,
    tracePath,
    coverage: o.coverage,
    memGc: o.memGc,
    settleTimeoutMs: o.settleTimeoutMs,
  };
}
