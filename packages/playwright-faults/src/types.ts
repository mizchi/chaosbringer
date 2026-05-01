/**
 * Public types for @mizchi/playwright-faults. Three layers of fault
 * injection share a few types (UrlMatcher, FaultStats shapes); each layer
 * has its own discriminated-union `Action` type.
 *
 *   1. Network — `FaultRule` / `Fault`        (Playwright `route()` interception)
 *   2. Page lifecycle — `LifecycleFault` / `LifecycleAction`
 *      (Playwright `Page` / `BrowserContext` / CDP at named stages)
 *   3. JS runtime — `RuntimeFault` / `RuntimeAction`
 *      (Playwright `addInitScript` per page nav)
 */

/** Anything that can match a URL. String inputs are compiled with `new RegExp`. */
export type UrlMatcher = string | RegExp;

/**
 * Minimal RNG contract used by the runtime-fault compiler. Caller passes
 * any object with `next(): number` returning [0, 1). Caller-provided so
 * playwright-faults stays seed-agnostic.
 */
export interface Rng {
  next(): number;
}

// =====================================================================
// 1. Network-level fault injection (Playwright route())
// =====================================================================

/** What to do when a FaultRule matches a request. */
export type Fault =
  | { kind: "abort"; errorCode?: string }
  | { kind: "status"; status: number; body?: string; contentType?: string }
  | { kind: "delay"; ms: number };

export interface FaultRule {
  /** Optional human-readable name used in stats. */
  name?: string;
  /** URL matcher — a regex literal or a regex string. */
  urlPattern: UrlMatcher;
  /** HTTP methods to match (case-insensitive). Empty = all methods. */
  methods?: string[];
  /** Action taken on a match. */
  fault: Fault;
  /** 0..1, default 1.0. Uses the caller-provided RNG. */
  probability?: number;
}

/** Per-rule stats for fault injection, emitted on the final report. */
export interface FaultInjectionStats {
  rule: string;
  matched: number;
  injected: number;
}

// =====================================================================
// 2. Page-lifecycle fault injection (Playwright Page / BrowserContext)
// =====================================================================

/**
 * When during a page's lifecycle a `LifecycleFault` fires.
 *
 * - `beforeNavigation`: before `page.goto` — for CDP-level conditions that need to
 *   apply during the load itself (CPU throttle, virtual time).
 * - `afterLoad`: right after navigation completes, before any chaos actions or
 *   `afterLoad` invariants run — for in-page mutations (storage clears, tamper).
 * - `beforeActions`: after `afterLoad` invariants pass, before the first chaos
 *   action — for one-shot evictions that should not affect invariants but should
 *   precede user simulation (Service Worker cache eviction).
 * - `betweenActions`: after every chaos action — for sustained pressure faults
 *   that need re-application across the action loop.
 */
export type LifecycleStage =
  | "beforeNavigation"
  | "afterLoad"
  | "beforeActions"
  | "betweenActions";

/** Where a `clear-storage` / `tamper-storage` action targets. */
export type StorageScope = "localStorage" | "sessionStorage" | "cookies" | "indexedDB";

/**
 * What a lifecycle fault does when it fires.
 *
 * Distinct from network-side `Fault` (which is request-scoped). These are
 * page-scoped client-side perturbations applied via the Playwright Page /
 * BrowserContext / CDP session.
 */
export type LifecycleAction =
  /**
   * Apply CPU throttling via CDP `Emulation.setCPUThrottlingRate`.
   * `rate` is a multiplier ≥ 1 (1 = no throttle, 4 = ~4× slower).
   */
  | { kind: "cpu-throttle"; rate: number }
  /** Wipe one or more storage scopes. */
  | { kind: "clear-storage"; scopes: StorageScope[] }
  /**
   * Drop entries from the Service Worker `caches` API. When `cacheNames` is
   * omitted, every cache is dropped.
   */
  | { kind: "evict-cache"; cacheNames?: string[] }
  /**
   * Set a single key/value in `localStorage` or `sessionStorage`. Useful for
   * forcing a logged-in app into "stale auth token" state and similar
   * targeted-corruption scenarios.
   */
  | {
      kind: "tamper-storage";
      scope: "localStorage" | "sessionStorage";
      key: string;
      value: string;
    };

/**
 * Page-level fault injected at a specific lifecycle stage. Network-level faults
 * stay on `FaultRule` (URL-matched, applied via Playwright `route()`).
 */
export interface LifecycleFault {
  /** Optional human-readable name used in stats. Auto-derived when omitted. */
  name?: string;
  /** When during the page lifecycle this fault fires. */
  when: LifecycleStage;
  /**
   * Restrict to URLs matching this matcher. Omit to apply on every page. For
   * `beforeNavigation` faults the about-to-be-navigated URL is matched.
   */
  urlPattern?: UrlMatcher;
  /** 0..1, default 1.0. Uses the caller-provided RNG. */
  probability?: number;
  /** What to do when the fault fires. */
  action: LifecycleAction;
}

/** Per-fault stats emitted on the final report. */
export interface LifecycleFaultStats {
  /** `name` from the `LifecycleFault`, or an auto-derived label. */
  name: string;
  /** Pages whose URL matched (regardless of probability). */
  matched: number;
  /** Pages where the fault actually fired (after the probability roll). */
  fired: number;
  /** Pages where the fault threw while firing. */
  errored: number;
}

// =====================================================================
// 3. JS-runtime fault injection (Playwright addInitScript)
// =====================================================================

/**
 * What a runtime fault does when it fires. Each kind is a persistent
 * monkey-patch installed in every page via `addInitScript`.
 */
export type RuntimeAction =
  /**
   * Reject `window.fetch` calls before any network round-trip. Different
   * from a network `Fault` of kind `"abort"`: `flaky-fetch` rejects the
   * Promise client-side with a TypeError, simulating "Failed to fetch" /
   * Service Worker reject / DNS failure.
   */
  | { kind: "flaky-fetch"; rejectionMessage?: string }
  /**
   * Skew `Date.now()` / `performance.now()` (and the no-arg `Date`
   * constructor) forward by `skewMs`. Useful for forcing token-expiry,
   * cache-bust, and "clock drift" code paths.
   */
  | { kind: "clock-skew"; skewMs: number };

/**
 * Page-level JS-runtime fault. Installed via `addInitScript` on every page
 * navigation. Distinct from `FaultRule` (request-scoped) and
 * `LifecycleFault` (one-shot at named stages of a page visit).
 */
export interface RuntimeFault {
  /** Optional human-readable name used in stats. Auto-derived when omitted. */
  name?: string;
  /**
   * Restrict to pages whose URL matches this matcher. Omitted = applies on
   * every page. The check happens inside the page (against `location.href`),
   * so the matcher must be JSON-serializable (string regex or RegExp literal).
   */
  urlPattern?: UrlMatcher;
  /** 0..1, default 1.0. Rolled per call against an in-page seeded RNG. */
  probability?: number;
  /** What to do when the fault fires. */
  action: RuntimeAction;
}

/** Per-fault stats for runtime fault injection, emitted on the final report. */
export interface RuntimeFaultStats {
  /** `name` from the `RuntimeFault`, or an auto-derived label. */
  rule: string;
  /** Times the fault was tested (URL matched, probability about to roll). */
  matched: number;
  /** Times the fault actually fired. */
  fired: number;
}
