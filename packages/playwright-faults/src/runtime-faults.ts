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

import {
  buildDecisionHelperSource,
  serializeSchedule,
  validateFaultSchedule,
} from "./schedule.js";
import type { Rng, RuntimeFault, RuntimeFaultStats, UrlMatcher } from "./types.js";
import { compileUrlMatcher, stripStatefulFlags } from "./url-matcher.js";

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
    case "reject-fetch":
      return `reject-fetch:${a.rejectAs ?? "TypeError"}`;
    case "never-settle-fetch":
      return "never-settle-fetch";
    case "reject-body":
      return `reject-body:${(a.consumers ?? ["json"]).join("+")}`;
    case "resolve-rejected-thenable":
      return "resolve-rejected-thenable";
    case "clock-skew":
      return `clock-skew:${a.skewMs}ms`;
  }
}

function compilePattern(matcher: UrlMatcher | undefined): RegExp | null {
  if (matcher === undefined) return null;
  return compileUrlMatcher(matcher);
}

export function compileRuntimeFaults(
  faults: RuntimeFault[] | undefined,
): CompiledRuntimeFault[] {
  if (!faults || faults.length === 0) return [];
  return faults.map((fault) => {
    validateFaultSchedule(`runtimeFault "${runtimeFaultName(fault)}"`, fault);
    return {
      fault,
      pattern: compilePattern(fault.urlPattern),
      name: runtimeFaultName(fault),
      matched: 0,
      fired: 0,
    };
  });
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
  // Stateful flags are stripped on the way into the page for the same reason
  // they are stripped on the way into `compilePattern`: the in-page script
  // rebuilds one RegExp and tests it against every `fetch()` the page makes,
  // so a `lastIndex` would carry across calls.
  if (m instanceof RegExp) return { source: m.source, flags: stripStatefulFlags(m.flags) };
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
  // Stats keys are indices, not names — two faults can legitimately share
  // a name (`flaky-fetch` x2 with different urlPatterns) and we mustn't
  // collapse their counters.
  const serialized = faults.map((f, i) => ({
    id: i,
    name: runtimeFaultName(f),
    pattern: serializeMatcher(f.urlPattern),
    methods: f.methods && f.methods.length > 0 ? f.methods.map((m) => m.toUpperCase()) : null,
    probability: typeof f.probability === "number" ? f.probability : 1,
    schedule: serializeSchedule(f.schedule),
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
  for (const f of faults) stats[String(f.id)] = { matched: 0, fired: 0 };

  const matchUrl = (pattern, url) => {
    if (!pattern) return true;
    try {
      return new RegExp(pattern.source, pattern.flags).test(url);
    } catch {
      return false;
    }
  };

  ${buildDecisionHelperSource()}

  // Occurrence = how many times this fault has matched so far in this frame.
  // Deciding and firing are two separate counts on purpose: a scheduled fault
  // whose decision is "inject" still advances its occurrence, but only one
  // fault can actually act on a given call. Counting \`fired\` here would
  // credit the runners-up with work they did not do — the network layer
  // increments \`injected\` only for the winner, and these two report the same
  // feature.
  const roll = (f) => {
    const slot = stats[String(f.id)];
    const occurrence = slot.matched;
    slot.matched++;
    return __decide(f, occurrence);
  };
  const fire = (f) => {
    stats[String(f.id)].fired++;
  };

  // --- fetch-scoped faults (Promise-level failure modes) ---
  const FETCH_KINDS = [
    "flaky-fetch",
    "reject-fetch",
    "never-settle-fetch",
    "reject-body",
    "resolve-rejected-thenable",
  ];
  const fetchFaults = faults.filter((f) => FETCH_KINDS.indexOf(f.action.kind) !== -1);
  if (fetchFaults.length > 0 && typeof window.fetch === "function") {
    const realFetch = window.fetch.bind(window);
    const makeError = (rejectAs, msg) => {
      if (rejectAs === "AbortError" && typeof DOMException === "function") {
        return new DOMException(msg, "AbortError");
      }
      return new TypeError(msg);
    };
    const methodOf = (input, init) => {
      if (init && typeof init.method === "string") return init.method.toUpperCase();
      if (input && typeof input === "object" && typeof input.method === "string") {
        return input.method.toUpperCase();
      }
      return "GET";
    };
    const matchMethod = (f, method) => !f.methods || f.methods.indexOf(method) !== -1;
    window.fetch = function chaosFetch(input, init) {
      const url =
        typeof input === "string" ? input :
        input instanceof URL ? input.toString() :
        (input && typeof input.url === "string") ? input.url :
        "";
      const method = methodOf(input, init);
      // Two passes. A *scheduled* fault always advances its occurrence
      // counter when its pattern matches, even if an earlier fault already
      // claimed this call — otherwise two faults watching the same URL
      // would number occurrences differently and a plan could not give
      // occurrence 0 to one outcome and occurrence 1 to another. Faults on
      // the probability path stay lazy (not consulted once a winner exists),
      // so existing seeds draw exactly as many numbers as before.
      let chosen = null;
      for (const f of fetchFaults) {
        if (!matchUrl(f.pattern, url)) continue;
        if (!matchMethod(f, method)) continue;
        if (f.schedule) {
          const fired = roll(f);
          if (fired && !chosen) chosen = f;
        } else if (!chosen) {
          if (roll(f)) chosen = f;
        }
      }
      if (chosen) {
        const f = chosen;
        fire(f);
        const a = f.action;
        const msg = a.rejectionMessage || "chaosbringer: simulated fetch failure";
        if (a.kind === "flaky-fetch") {
          return Promise.reject(new TypeError(msg));
        }
        if (a.kind === "reject-fetch") {
          return Promise.reject(makeError(a.rejectAs, msg));
        }
        if (a.kind === "never-settle-fetch") {
          // No request, no settlement — the caller waits forever *unless it
          // cancels*, which is what a real hung request does: an
          // AbortController (or AbortSignal.timeout) still rejects it. Without
          // honouring the signal this fault would report a correctly-bounded
          // app as stuck.
          const signal = (init && init.signal) || (input && input.signal) || null;
          if (!signal) return new Promise(() => {});
          const abortError = () =>
            signal.reason ||
            (typeof DOMException === "function"
              ? new DOMException("The operation was aborted.", "AbortError")
              : new Error("The operation was aborted."));
          return new Promise((_resolve, reject) => {
            if (signal.aborted) {
              reject(abortError());
              return;
            }
            signal.addEventListener("abort", () => { reject(abortError()); }, { once: true });
          });
        }
        if (a.kind === "resolve-rejected-thenable") {
          // Resolving *with a thenable* means the rejection arrives one
          // microtask later, through the assimilation path.
          //
          // \`TypeError\` directly, not \`makeError(a.rejectAs, …)\`: this action
          // has no \`rejectAs\` field (see \`RuntimeAction\` in types.ts), so the
          // read was always \`undefined\` and the helper always returned a
          // TypeError anyway. The emitted script is a template string, so TS
          // never saw the mistake — worth remembering when reading the rest
          // of this function.
          return Promise.resolve({
            then: (_resolve, reject) => { reject(new TypeError(msg)); },
          });
        }
        if (a.kind === "reject-body") {
          const consumers = a.consumers && a.consumers.length > 0 ? a.consumers : ["json"];
          return realFetch(input, init).then((res) => {
            // Own properties shadow Response.prototype, so "instanceof
            // Response", res.ok, headers and status all stay real — only
            // the body consumers reject.
            for (const name of consumers) {
              try {
                Object.defineProperty(res, name, {
                  configurable: true,
                  writable: true,
                  value: () => Promise.reject(new TypeError(msg)),
                });
              } catch (e) {
                // Frozen response (shouldn't happen) — leave it alone.
              }
            }
            return res;
          });
        }
      }
      return realFetch(input, init);
    };
  }

  // --- clock-skew ---
  const skewFaults = faults.filter((f) => f.action.kind === "clock-skew");
  if (skewFaults.length > 0) {
    // Use a plain accumulator. Multi-day skews (e.g. 30 days ~ 2.6e9 ms)
    // exceed int32 max, so any '| 0' truncation here would flip them negative.
    let totalSkew = 0;
    for (const f of skewFaults) {
      if (matchUrl(f.pattern, location.href) && roll(f)) {
        fire(f);
        totalSkew += Number(f.action.skewMs);
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
 *
 * Stats keys are array indices so two faults with the same name don't
 * collide their counters. Both legacy name-keyed snapshots and the
 * current index-keyed shape are accepted: name-keyed entries are applied
 * to the first compiled fault with that name (the safe, non-collapsing
 * fallback used when reading older traces).
 */
export function mergeRuntimeStats(
  compiled: CompiledRuntimeFault[],
  pageStats: Record<string, { matched: number; fired: number }>,
): RuntimeFaultStats[] {
  for (let i = 0; i < compiled.length; i++) {
    const c = compiled[i]!;
    // Index-keyed (current shape).
    const ps = pageStats[String(i)];
    if (ps) {
      c.matched += ps.matched;
      c.fired += ps.fired;
      continue;
    }
    // Backwards-compat: name-keyed (one slot per distinct name only;
    // applied to the first compiled fault that wears that name).
    const byName = pageStats[c.name];
    if (byName && !compiled.slice(0, i).some((c2) => c2.name === c.name)) {
      c.matched += byName.matched;
      c.fired += byName.fired;
    }
  }
  return compiled.map((c) => ({
    rule: c.name,
    matched: c.matched,
    fired: c.fired,
  }));
}
