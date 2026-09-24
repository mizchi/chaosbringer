// Pure constants shared by the core (controller, session) and the config edge.
// Side-effect free and dependency free: the single home of these values
// (config.ts, cli.ts and the core all import them from here, not via config).
//
// NET_PROFILES are lightbringer's own PERF_NET / --net presets; chaosbringer's
// --network presets are a separate table with different numbers (see
// docs/recipes/perf.md). Keep them apart; do not "sync" the values.

/** Network emulation profile (throughput in bytes/s, latency in ms). */
export interface NetProfile {
  latency: number;
  downloadThroughput: number;
  uploadThroughput: number;
}

/** Approximate DevTools-style presets, selectable by PERF_NET / --net. */
export const NET_PROFILES: Readonly<Record<string, NetProfile>> = {
  "slow-3g": { latency: 400, downloadThroughput: 51_200, uploadThroughput: 51_200 },
  "fast-3g": { latency: 150, downloadThroughput: 196_608, uploadThroughput: 98_304 },
  "4g": { latency: 40, downloadThroughput: 1_179_648, uploadThroughput: 589_824 },
};

/** Look up a NET_PROFILES preset by name (own keys only); null when unknown/unset. */
export function netProfileByName(name: string | undefined): NetProfile | null {
  return name && Object.hasOwn(NET_PROFILES, name) ? NET_PROFILES[name] : null;
}

/** Default max time to wait for settle before marking a span capped (ms). */
export const DEFAULT_SETTLE_TIMEOUT_MS = 5000;

/**
 * Default max time one in-page read (page.evaluate) at a span boundary or in
 * finish() may take before its fallback is used (ms). The reads themselves take
 * milliseconds; only a page that cannot answer (a navigation whose document
 * request never completes, a main thread that never yields) reaches this.
 */
export const DEFAULT_EVALUATE_TIMEOUT_MS = 5000;
