/**
 * The `perf` option: its validation, its defaults, and the `--perf*` CLI
 * flags that build it. Pure, so every rule is unit-testable without a browser.
 */

import type { PerfOptions } from "./types.js";

/** `perf` with every default filled in. */
export interface ResolvedPerfOptions {
  level: "light" | "trace";
  memGc: boolean;
  coverage: boolean;
  cssSelectorStats: boolean;
  outDir?: string;
  actions: boolean;
}

/**
 * Where a trace goes when `level: "trace"` is on and no `outDir` was given. A
 * trace is streamed to disk while it is recorded, so it needs a path whether
 * or not the caller asked for artefacts.
 */
export const DEFAULT_PERF_TRACE_DIR = "chaosbringer-perf";

/**
 * Resolve the `perf` option, or `null` when measurement is off. `true` is
 * `{ level: "light" }`; `false` and `undefined` are off. `cssSelectorStats`
 * is recorded into a trace, so it implies `level: "trace"`, and a trace needs
 * a directory, so trace level without `outDir` gets the default one.
 */
export function resolvePerfOptions(perf: boolean | PerfOptions | undefined): ResolvedPerfOptions | null {
  if (perf === undefined || perf === false) return null;
  const opts: PerfOptions = perf === true ? {} : perf;
  const cssSelectorStats = opts.cssSelectorStats ?? false;
  const level = cssSelectorStats ? "trace" : (opts.level ?? "light");
  const outDir = opts.outDir ?? (level === "trace" ? DEFAULT_PERF_TRACE_DIR : undefined);
  return {
    level,
    memGc: opts.memory?.forceGc ?? false,
    coverage: opts.coverage ?? false,
    cssSelectorStats,
    ...(outDir !== undefined ? { outDir } : {}),
    actions: opts.actions ?? true,
  };
}

/** The `--perf*` CLI flags, as `parseArgs` hands them over. */
export interface PerfCliFlags {
  perf?: boolean;
  "perf-trace"?: boolean;
  "perf-mem"?: boolean;
  "perf-cov"?: boolean;
  "perf-out"?: string;
}

/**
 * Map the `--perf*` flags onto `CrawlerOptions.perf`. Every flag implies
 * `--perf`: a `--perf-trace` that did nothing without a second flag would be
 * read as "the trace was empty". No flag at all leaves `perf` unset.
 */
export function perfOptionsFromCliFlags(flags: PerfCliFlags): boolean | PerfOptions | undefined {
  const trace = flags["perf-trace"] === true;
  const mem = flags["perf-mem"] === true;
  const cov = flags["perf-cov"] === true;
  const outDir = flags["perf-out"];
  if (!flags.perf && !trace && !mem && !cov && outDir === undefined) return undefined;
  if (!trace && !mem && !cov && outDir === undefined) return true;
  return {
    ...(trace ? { level: "trace" as const } : {}),
    ...(mem ? { memory: { forceGc: true } } : {}),
    ...(cov ? { coverage: true } : {}),
    ...(outDir !== undefined ? { outDir } : {}),
  };
}

// `satisfies` makes the list exhaustive: a key added to `PerfOptions` without
// being listed here fails to compile instead of being refused at runtime.
const PERF_OPTION_NAMES = new Set(
  Object.keys({
    level: true,
    memory: true,
    coverage: true,
    cssSelectorStats: true,
    outDir: true,
    actions: true,
  } satisfies Record<keyof PerfOptions, true>),
);

/**
 * `perf` is a boolean or an object of flags. Unknown keys are refused outright
 * rather than only near misses: the object is small and closed, and a
 * `{ trace: true }` that silently measured at light level would be read as
 * "the trace was empty".
 */
export function validatePerf(perf: unknown): void {
  if (typeof perf === "boolean") return;
  if (perf === null || typeof perf !== "object" || Array.isArray(perf)) {
    throw new Error(
      `chaosbringer: "perf" must be a boolean or an options object (got ${JSON.stringify(perf)})`
    );
  }
  const p = perf as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (!PERF_OPTION_NAMES.has(key)) {
      throw new Error(
        `chaosbringer: "perf.${key}" is not a perf option (allowed: ${[...PERF_OPTION_NAMES].join(", ")})`
      );
    }
  }
  if (p.level !== undefined && p.level !== "light" && p.level !== "trace") {
    throw new Error(
      `chaosbringer: "perf.level" must be "light" or "trace" (got ${JSON.stringify(p.level)})`
    );
  }
  for (const key of ["coverage", "cssSelectorStats", "actions"] as const) {
    if (p[key] !== undefined && typeof p[key] !== "boolean") {
      throw new Error(`chaosbringer: "perf.${key}" must be a boolean (got ${JSON.stringify(p[key])})`);
    }
  }
  if (p.memory !== undefined) {
    const m = p.memory as Record<string, unknown> | null;
    if (m === null || typeof m !== "object" || Array.isArray(m)) {
      throw new Error(`chaosbringer: "perf.memory" must be an object like { forceGc: true }`);
    }
    if (m.forceGc !== undefined && typeof m.forceGc !== "boolean") {
      throw new Error(
        `chaosbringer: "perf.memory.forceGc" must be a boolean (got ${JSON.stringify(m.forceGc)})`
      );
    }
  }
  if (p.outDir !== undefined && (typeof p.outDir !== "string" || p.outDir.length === 0)) {
    throw new Error(`chaosbringer: "perf.outDir" must be a non-empty string`);
  }
}
