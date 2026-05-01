/**
 * JS-runtime fault injection.
 *
 * Distinct from `FaultRule` (request-scoped, applied via Playwright `route()`)
 * and `LifecycleFault` (one-shot at named stages of a page visit). These are
 * persistent monkey-patches injected into every page via `addInitScript`,
 * subverting in-page JS APIs (fetch / Date / storage / addEventListener) so
 * the app sees client-side failures that no network mock would expose.
 *
 * Examples:
 *   - `flaky-fetch`: `window.fetch` rejects with a TypeError before any
 *     network round-trip — simulates "Failed to fetch" / DNS down / Service
 *     Worker reject. Different from `faults.status(500)`, which still
 *     resolves the promise.
 *   - `clock-skew`: `Date.now` / `performance.now` are shifted forward by N
 *     ms — exposes token-expiry / cache-bust bugs on long sessions.
 *
 * Pure helpers (`buildRuntimeFaultsScript`, `runtimeFaultName`,
 * `compileRuntimeFaults`) generate / serialize the init script and roll
 * probability — unit-testable without a browser. Stats are reported by the
 * in-page script via a known `window.__chaosbringerRuntimeStats` global; the
 * crawler reads it after each page visit.
 */

import type { Rng } from "./random.js";
import type { RuntimeFault, RuntimeFaultStats, UrlMatcher } from "./types.js";

/** Compiled form: regex pre-compiled, name pre-derived. */
export interface CompiledRuntimeFault {
  fault: RuntimeFault;
  /** null when `fault.urlPattern` was omitted. */
  pattern: RegExp | null;
  name: string;
  matched: number;
  fired: number;
}

/** Auto-derive a stats label when the user didn't set `fault.name`. */
export function runtimeFaultName(fault: RuntimeFault): string {
  if (fault.name) return fault.name;
  const a = fault.action;
  switch (a.kind) {
    case "flaky-fetch":
      return "flaky-fetch";
    case "clock-skew":
      return `clock-skew:${a.skewMs}ms`;
  }
}

function compilePattern(matcher: UrlMatcher | undefined): RegExp | null {
  if (matcher === undefined) return null;
  return matcher instanceof RegExp ? matcher : new RegExp(matcher);
}

export function compileRuntimeFaults(
  faults: RuntimeFault[] | undefined,
): CompiledRuntimeFault[] {
  if (!faults || faults.length === 0) return [];
  return faults.map((fault) => ({
    fault,
    pattern: compilePattern(fault.urlPattern),
    name: runtimeFaultName(fault),
    matched: 0,
    fired: 0,
  }));
}

/** True when `compiled.pattern` matches `url` (or no pattern was set). */
export function runtimeMatchesUrl(
  compiled: Pick<CompiledRuntimeFault, "pattern">,
  url: string,
): boolean {
  return compiled.pattern === null || compiled.pattern.test(url);
}

/**
 * Decide whether a probabilistic fault fires this time. Mirrors the
 * lifecycle / network helpers so all three layers share a deterministic
 * roll behaviour given the same RNG.
 */
export function shouldFireProbability(probability: number | undefined, rng: Rng): boolean {
  const p = probability ?? 1;
  if (p >= 1) return true;
  if (p <= 0) return false;
  return rng.next() < p;
}

/**
 * Serialize a UrlMatcher into a structure the in-page script can rebuild
 * without `eval`. Strings stay strings; RegExp becomes `{ source, flags }`.
 */
function serializeMatcher(m: UrlMatcher | undefined): { source: string; flags: string } | null {
  if (m === undefined) return null;
  if (m instanceof RegExp) return { source: m.source, flags: m.flags };
  return { source: m, flags: "" };
}

/**
 * Build the init script body. Self-contained IIFE — no closure over the
 * caller's scope, no external imports — because Playwright serializes init
 * scripts as plain text and runs them in a fresh frame on every navigation.
 *
 * `seed` lets each page roll deterministic probabilities. Pass the
 * crawler's seed so a `(seed, runtimeFaults)` pair always produces the same
 * pattern of injections.
 */
export function buildRuntimeFaultsScript(
  faults: ReadonlyArray<RuntimeFault>,
  seed: number,
): string {
  const serialized = faults.map((f) => ({
    name: runtimeFaultName(f),
    pattern: serializeMatcher(f.urlPattern),
    probability: typeof f.probability === "number" ? f.probability : 1,
    action: f.action,
  }));

  // Body of the init script. Indented for readability; whitespace is fine
  // because Playwright won't minify it.
  return `(() => {
  if (typeof window === "undefined") return;
  if (window.__chaosbringerRuntimeFaultsInstalled) return;
  window.__chaosbringerRuntimeFaultsInstalled = true;
  window.__chaosbringerRuntimeStats = {};

  // Park-Miller LCG — small, deterministic, good enough for fault rolls.
  let __rng = ${seed >>> 0} || 1;
  const __nextRoll = () => {
    __rng = ((__rng * 16807) % 2147483647) | 0;
    if (__rng <= 0) __rng += 2147483647;
    return (__rng - 1) / 2147483646;
  };

  const faults = ${JSON.stringify(serialized)};
  const stats = window.__chaosbringerRuntimeStats;
  for (const f of faults) stats[f.name] = { matched: 0, fired: 0 };

  const matchUrl = (pattern, url) => {
    if (!pattern) return true;
    try {
      return new RegExp(pattern.source, pattern.flags).test(url);
    } catch {
      return false;
    }
  };

  const roll = (f) => {
    stats[f.name].matched++;
    if (f.probability >= 1) {
      stats[f.name].fired++;
      return true;
    }
    if (f.probability <= 0) return false;
    const fired = __nextRoll() < f.probability;
    if (fired) stats[f.name].fired++;
    return fired;
  };

  // --- flaky-fetch ---
  const fetchFaults = faults.filter((f) => f.action.kind === "flaky-fetch");
  if (fetchFaults.length > 0 && typeof window.fetch === "function") {
    const realFetch = window.fetch.bind(window);
    window.fetch = function chaosFetch(input, init) {
      const url =
        typeof input === "string" ? input :
        input instanceof URL ? input.toString() :
        (input && typeof input.url === "string") ? input.url :
        "";
      for (const f of fetchFaults) {
        if (matchUrl(f.pattern, url) && roll(f)) {
          const msg = f.action.rejectionMessage || "chaosbringer: simulated fetch failure";
          return Promise.reject(new TypeError(msg));
        }
      }
      return realFetch(input, init);
    };
  }

  // --- clock-skew ---
  const skewFaults = faults.filter((f) => f.action.kind === "clock-skew");
  if (skewFaults.length > 0) {
    let totalSkew = 0;
    for (const f of skewFaults) {
      if (matchUrl(f.pattern, location.href) && roll(f)) {
        totalSkew += f.action.skewMs | 0;
      }
    }
    if (totalSkew !== 0) {
      const realDateNow = Date.now.bind(Date);
      Date.now = () => realDateNow() + totalSkew;
      const realPerfNow = performance.now.bind(performance);
      performance.now = () => realPerfNow() + totalSkew;
      // Patch the Date constructor so \`new Date()\` (no args) also skews.
      const RealDate = Date;
      const SkewedDate = function (...args) {
        if (args.length === 0) return new RealDate(realDateNow() + totalSkew);
        // @ts-ignore
        return new RealDate(...args);
      };
      SkewedDate.now = Date.now;
      SkewedDate.UTC = RealDate.UTC;
      SkewedDate.parse = RealDate.parse;
      SkewedDate.prototype = RealDate.prototype;
      // @ts-ignore
      window.Date = SkewedDate;
    }
  }
})();`;
}

/**
 * Read the in-page stats counter and merge into the compiled-fault counters
 * (`matched` and `fired`). Returns the merged stats; the compiled-fault
 * objects are mutated in place so the next page picks up where this one
 * left off.
 */
export function mergeRuntimeStats(
  compiled: CompiledRuntimeFault[],
  pageStats: Record<string, { matched: number; fired: number }>,
): RuntimeFaultStats[] {
  for (const c of compiled) {
    const ps = pageStats[c.name];
    if (!ps) continue;
    c.matched += ps.matched;
    c.fired += ps.fired;
  }
  return compiled.map((c) => ({
    rule: c.name,
    matched: c.matched,
    fired: c.fired,
  }));
}
