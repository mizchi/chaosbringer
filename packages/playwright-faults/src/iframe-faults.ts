/**
 * Iframe-load fault injection.
 *
 * Sibling of `runtime-faults` — installed via `addInitScript`, applied by
 * monkey-patching `HTMLIFrameElement.prototype.src` (and `setAttribute("src",
 * ...)`). The patch fires the moment the host page assigns the iframe's URL,
 * giving us three primitives that `FaultRule` / `LifecycleFault` /
 * `RuntimeFault` can't express:
 *
 *   - `load-delay`: `src` is assigned after a `setTimeout(ms)`, so the
 *     contained document loads `ms` ms later than it normally would and the
 *     parent's `iframe.onload` fires correspondingly late.
 *   - `never-load`: `src` is set to `about:blank` so the host library's
 *     onload-driven impression / no-fill logic sees a blank document.
 *   - `remove-mid-load`: `src` is assigned for real, then `iframe.remove()`
 *     is scheduled after `atMs` to simulate user-initiated close races.
 *
 * Pure helpers (`buildIframeFaultsScript`, `iframeFaultName`,
 * `compileIframeFaults`) generate / serialize the init script and roll
 * probability — unit-testable without a browser. Stats are reported by the
 * in-page script via `window.__chaosbringerIframeFaultStats`; the crawler
 * reads it after each page visit.
 */

import {
  buildDecisionHelperSource,
  serializeSchedule,
  validateFaultSchedule,
} from "./schedule.js";
import type { IframeAction, IframeFault, IframeFaultStats } from "./types.js";
import { assertCompiledFaults } from "./compiled-guard.js";

/** Compiled form: stats counters initialised, name pre-derived. */
export interface CompiledIframeFault {
  fault: IframeFault;
  name: string;
  matched: number;
  fired: number;
  /** Decided "inject" while an earlier fault was already claiming the iframe. */
  suppressed: number;
}

/** Auto-derive a stats label when the user didn't set `fault.name`. */
export function iframeFaultName(fault: IframeFault): string {
  if (fault.name) return fault.name;
  const a = fault.action;
  switch (a.kind) {
    case "load-delay":
      return `iframe-load-delay:${a.ms}ms`;
    case "never-load":
      return "iframe-never-load";
    case "remove-mid-load":
      return `iframe-remove-mid-load:${a.atMs}ms`;
  }
}

export function compileIframeFaults(
  faults: IframeFault[] | undefined,
): CompiledIframeFault[] {
  if (!faults || faults.length === 0) return [];
  return faults.map((fault) => {
    validateFaultSchedule(`iframeFault "${iframeFaultName(fault)}"`, fault);
    return {
      fault,
      name: iframeFaultName(fault),
      matched: 0,
      fired: 0,
      suppressed: 0,
    };
  });
}

/** Action discriminator for stats reporting. */
function actionKind(a: IframeAction): IframeFaultStats["action"] {
  return a.kind;
}

/**
 * Build the init script body. Self-contained IIFE — no closure over the
 * caller's scope, no external imports — because Playwright serializes init
 * scripts as plain text and runs them in a fresh frame on every navigation.
 *
 * `seed` lets each page roll deterministic probabilities. Pass the
 * crawler's seed so a `(seed, iframeFaults)` pair always produces the same
 * pattern of injections.
 */
export function buildIframeFaultsScript(
  faults: ReadonlyArray<IframeFault>,
  seed: number,
): string {
  const serialized = faults.map((f, i) => ({
    id: i,
    name: iframeFaultName(f),
    selector: f.selector,
    probability: typeof f.probability === "number" ? f.probability : 1,
    schedule: serializeSchedule(f.schedule),
    action: f.action,
  }));

  return `(() => {
  if (typeof window === "undefined") return;
  if (typeof HTMLIFrameElement === "undefined") return;
  if (window.__chaosbringerIframeFaultsInstalled) return;
  window.__chaosbringerIframeFaultsInstalled = true;
  window.__chaosbringerIframeFaultStats = {};

  // Park-Miller LCG — matches runtime-faults so seeded rolls stay deterministic.
  let __rng = ${seed >>> 0} || 1;
  const __nextRoll = () => {
    __rng = ((__rng * 16807) % 2147483647) | 0;
    if (__rng <= 0) __rng += 2147483647;
    return (__rng - 1) / 2147483646;
  };

  const faults = ${JSON.stringify(serialized)};
  const stats = window.__chaosbringerIframeFaultStats;
  for (const f of faults) stats[String(f.id)] = { matched: 0, fired: 0, suppressed: 0 };

  ${buildDecisionHelperSource()}

  // Occurrence = how many matching iframes this fault has seen in this frame.
  // Deciding and firing are separate counts, as on the network and runtime
  // layers: a scheduled fault whose decision is "inject" still advances its
  // occurrence, but only one fault can act on a given iframe.
  const roll = (f) => {
    const slot = stats[String(f.id)];
    const occurrence = slot.matched;
    slot.matched++;
    return __decide(f, occurrence);
  };
  const fire = (f) => { stats[String(f.id)].fired++; };
  const suppress = (f) => { stats[String(f.id)].suppressed++; };

  const HIFE = HTMLIFrameElement.prototype;
  const srcDescriptor = Object.getOwnPropertyDescriptor(HIFE, "src");
  const setRealSrc = srcDescriptor && srcDescriptor.set;
  const getRealSrc = srcDescriptor && srcDescriptor.get;
  if (!setRealSrc || !getRealSrc) return;

  const realSetAttribute = HIFE.setAttribute;

  // Returns true if a fault claimed responsibility for this src assignment.
  function handleSrc(iframe, value) {
    // Two passes, like the network and runtime layers. This was single-pass —
    // the first fault to claim the iframe returned, so a *scheduled* fault
    // behind it never advanced its occurrence and therefore never fired. That
    // made \`decisions\` mean something different here than on the other layers,
    // silently, while the docs promised one shape understood by all four.
    let chosen = null;
    for (const f of faults) {
      let matched;
      try {
        matched = iframe.matches(f.selector);
      } catch {
        matched = false;
      }
      if (!matched) continue;
      if (f.schedule) {
        // A scheduled fault always consumes its occurrence when its selector
        // matches, so two faults watching one iframe agree about what
        // "occurrence 1" means.
        if (roll(f)) {
          if (chosen) suppress(f);
          else chosen = f;
        }
        continue;
      }
      // Probability stays lazy: never consulted once a winner exists, so
      // existing seeds draw exactly as many numbers as before.
      if (chosen) continue;
      if (roll(f)) chosen = f;
    }
    if (chosen) {
      const f = chosen;
      fire(f);
      const action = f.action;
      if (action.kind === "load-delay") {
        const ms = Number(action.ms);
        setTimeout(() => {
          try { setRealSrc.call(iframe, value); } catch {}
        }, Number.isFinite(ms) && ms >= 0 ? ms : 0);
        return true;
      }
      if (action.kind === "never-load") {
        try { setRealSrc.call(iframe, "about:blank"); } catch {}
        return true;
      }
      if (action.kind === "remove-mid-load") {
        try { setRealSrc.call(iframe, value); } catch {}
        const atMs = Number(action.atMs);
        setTimeout(() => {
          try { iframe.remove(); } catch {}
        }, Number.isFinite(atMs) && atMs >= 0 ? atMs : 0);
        return true;
      }
    }
    return false;
  }

  Object.defineProperty(HIFE, "src", {
    configurable: true,
    enumerable: srcDescriptor.enumerable,
    get() { return getRealSrc.call(this); },
    set(value) {
      const v = value == null ? "" : String(value);
      if (handleSrc(this, v)) return;
      setRealSrc.call(this, v);
    },
  });

  HIFE.setAttribute = function (name, value) {
    if (name && String(name).toLowerCase() === "src") {
      const v = value == null ? "" : String(value);
      if (handleSrc(this, v)) return;
      return realSetAttribute.call(this, name, v);
    }
    return realSetAttribute.call(this, name, value);
  };
})();`;
}

/**
 * Read the in-page stats counter and merge into the compiled-fault counters.
 * Returns the merged stats; the compiled-fault objects are mutated in place
 * so the next page picks up where this one left off.
 */
export function mergeIframeStats(
  compiled: CompiledIframeFault[],
  pageStats: Record<string, { matched: number; fired: number; suppressed?: number }>,
): IframeFaultStats[] {
  assertCompiledFaults("mergeIframeStats", "compileIframeFaults", compiled);
  for (let i = 0; i < compiled.length; i++) {
    const c = compiled[i]!;
    const ps = pageStats[String(i)];
    if (ps) {
      c.matched += ps.matched;
      c.fired += ps.fired;
      c.suppressed += ps.suppressed ?? 0;
    }
  }
  return compiled.map((c) => ({
    rule: c.name,
    selector: c.fault.selector,
    action: actionKind(c.fault.action),
    matched: c.matched,
    fired: c.fired,
    ...(c.suppressed > 0 ? { suppressed: c.suppressed } : {}),
  }));
}
