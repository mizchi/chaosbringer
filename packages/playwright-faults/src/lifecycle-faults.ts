/**
 * Page-lifecycle fault injection.
 *
 * Distinct from network-side `FaultRule` (request-scoped, applied via
 * Playwright `route()`). These are page-scoped client-side perturbations
 * applied at well-defined stages of a page visit — CPU throttle, storage
 * wipe, Service Worker cache eviction, key/value tampering. The crawler
 * decides when to call into the executor; the executor decides how to
 * realise each `LifecycleAction` against the browser.
 *
 * Pure helpers (compile / match / probability roll / name derivation) live
 * here so the routing logic is unit-testable without a real browser. The
 * Playwright-backed executor lives at the bottom of this file.
 */

import type { BrowserContext, CDPSession, Page } from "playwright";
import type {
  LifecycleAction,
  LifecycleFault,
  LifecycleFaultStats,
  LifecycleStage,
  UrlMatcher,
} from "./types.js";

/** Compiled form: regex pre-compiled, name pre-derived. */
export interface CompiledLifecycleFault {
  fault: LifecycleFault;
  /** null when `fault.urlPattern` was omitted (matches every URL). */
  pattern: RegExp | null;
  name: string;
  matched: number;
  fired: number;
  errored: number;
}

/** Auto-derive a stats label when the user didn't set `fault.name`. */
export function lifecycleFaultName(fault: LifecycleFault): string {
  if (fault.name) return fault.name;
  const a = fault.action;
  switch (a.kind) {
    case "cpu-throttle":
      return `cpu-throttle:${a.rate}x`;
    case "clear-storage":
      return `clear-storage:${a.scopes.join("+")}`;
    case "evict-cache":
      return a.cacheNames && a.cacheNames.length > 0
        ? `evict-cache:${a.cacheNames.join("+")}`
        : "evict-cache";
    case "tamper-storage":
      return `tamper-storage:${a.scope}.${a.key}`;
  }
}

function compilePattern(matcher: UrlMatcher | undefined): RegExp | null {
  if (matcher === undefined) return null;
  return matcher instanceof RegExp ? matcher : new RegExp(matcher);
}

export function compileLifecycleFaults(
  faults: LifecycleFault[] | undefined,
): CompiledLifecycleFault[] {
  if (!faults || faults.length === 0) return [];
  return faults.map((fault) => ({
    fault,
    pattern: compilePattern(fault.urlPattern),
    name: lifecycleFaultName(fault),
    matched: 0,
    fired: 0,
    errored: 0,
  }));
}

/** True when `compiled.pattern` matches `url` (or no pattern was set). */
export function lifecycleMatchesUrl(
  compiled: Pick<CompiledLifecycleFault, "pattern">,
  url: string,
): boolean {
  return compiled.pattern === null || compiled.pattern.test(url);
}

/**
 * Roll the seeded RNG against `probability`. Returns true when the fault
 * should fire. `prob >= 1` (or undefined) always fires; `prob <= 0` never
 * fires; anything in between samples one number from `rng`.
 *
 * RNG consumption is deliberately conditional on `prob < 1` so that adding
 * a probability-1 fault to a config doesn't shift the seed sequence for
 * existing chaos action selection.
 */
export function shouldFireProbability(
  prob: number | undefined,
  rng: { next(): number },
): boolean {
  if (prob === undefined || prob >= 1) return true;
  if (prob <= 0) return false;
  return rng.next() < prob;
}

/** Pick the compiled faults that target a given lifecycle stage. */
export function lifecycleFaultsAtStage(
  compiled: readonly CompiledLifecycleFault[],
  stage: LifecycleStage,
): CompiledLifecycleFault[] {
  return compiled.filter((c) => c.fault.when === stage);
}

export function lifecycleStatsFrom(
  compiled: readonly CompiledLifecycleFault[],
): LifecycleFaultStats[] {
  return compiled.map((c) => ({
    name: c.name,
    matched: c.matched,
    fired: c.fired,
    errored: c.errored,
  }));
}

/**
 * Browser-side primitives needed to realise each `LifecycleAction`. One
 * method per action kind so tests can fake exactly what they exercise
 * without standing up Playwright.
 */
export interface LifecycleActionExecutor {
  cpuThrottle(rate: number): Promise<void>;
  clearStorage(scopes: readonly ("localStorage" | "sessionStorage" | "cookies" | "indexedDB")[]): Promise<void>;
  evictCache(cacheNames?: readonly string[]): Promise<void>;
  tamperStorage(scope: "localStorage" | "sessionStorage", key: string, value: string): Promise<void>;
}

/** Dispatch a single `LifecycleAction` to the right executor method. */
export async function executeLifecycleAction(
  action: LifecycleAction,
  executor: LifecycleActionExecutor,
): Promise<void> {
  switch (action.kind) {
    case "cpu-throttle":
      await executor.cpuThrottle(action.rate);
      return;
    case "clear-storage":
      await executor.clearStorage(action.scopes);
      return;
    case "evict-cache":
      await executor.evictCache(action.cacheNames);
      return;
    case "tamper-storage":
      await executor.tamperStorage(action.scope, action.key, action.value);
      return;
  }
}

/**
 * Real executor backed by Playwright. CPU throttle requires a CDP session;
 * we attach lazily and reuse across calls on the same page.
 */
export class PlaywrightLifecycleExecutor implements LifecycleActionExecutor {
  private cdp: Promise<CDPSession> | null = null;

  constructor(
    private readonly page: Page,
    private readonly context: BrowserContext,
  ) {}

  private getCdp(): Promise<CDPSession> {
    if (this.cdp === null) {
      this.cdp = this.context.newCDPSession(this.page);
    }
    return this.cdp;
  }

  async cpuThrottle(rate: number): Promise<void> {
    const client = await this.getCdp();
    await client.send("Emulation.setCPUThrottlingRate", { rate });
  }

  async clearStorage(
    scopes: readonly ("localStorage" | "sessionStorage" | "cookies" | "indexedDB")[],
  ): Promise<void> {
    const inPage = scopes.filter((s) => s !== "cookies");
    if (inPage.length > 0) {
      // page.evaluate runs in the page context; we pass the scope set so the
      // browser side decides which storages to wipe without us injecting JS.
      await this.page.evaluate(async (scopeList: readonly string[]) => {
        const s = new Set(scopeList);
        if (s.has("localStorage")) {
          try {
            window.localStorage.clear();
          } catch {
            /* SecurityError on opaque origins */
          }
        }
        if (s.has("sessionStorage")) {
          try {
            window.sessionStorage.clear();
          } catch {
            /* SecurityError on opaque origins */
          }
        }
        if (s.has("indexedDB") && "indexedDB" in window) {
          // databases() is not in every browser; guard.
          // @ts-ignore - older lib.dom typings omit databases()
          const dbs: Array<{ name?: string }> = (await indexedDB.databases?.()) ?? [];
          await Promise.all(
            dbs
              .map((d) => d.name)
              .filter((n): n is string => typeof n === "string")
              .map(
                (name) =>
                  new Promise<void>((resolve) => {
                    const req = indexedDB.deleteDatabase(name);
                    req.onsuccess = () => resolve();
                    req.onerror = () => resolve();
                    req.onblocked = () => resolve();
                  }),
              ),
          );
        }
      }, inPage);
    }
    if (scopes.includes("cookies")) {
      // Context-level: drops every cookie across every page in the context.
      await this.context.clearCookies();
    }
  }

  async evictCache(cacheNames?: readonly string[]): Promise<void> {
    await this.page.evaluate(async (names: readonly string[] | undefined) => {
      if (!("caches" in self)) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (self as any).caches as CacheStorage;
      const all = await c.keys();
      const target = names && names.length > 0 ? all.filter((k) => names.includes(k)) : all;
      await Promise.all(target.map((k) => c.delete(k)));
    }, cacheNames);
  }

  async tamperStorage(
    scope: "localStorage" | "sessionStorage",
    key: string,
    value: string,
  ): Promise<void> {
    await this.page.evaluate(
      ({ scope, key, value }: { scope: "localStorage" | "sessionStorage"; key: string; value: string }) => {
        try {
          (scope === "localStorage" ? window.localStorage : window.sessionStorage).setItem(key, value);
        } catch {
          /* SecurityError on opaque origins */
        }
      },
      { scope, key, value },
    );
  }
}
