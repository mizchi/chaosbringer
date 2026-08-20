/**
 * Small helper functions that build FaultRule objects without the
 * discriminated-union ceremony. Exported from the package root.
 *
 *   import { faults } from "chaosbringer";
 *   const rules = [
 *     faults.status(500, { urlPattern: /\/api\// }),
 *     faults.abort({ urlPattern: /tracking/ }),
 *     faults.delay(2000, { urlPattern: /\/api\// }),
 *   ];
 */

import type {
  FaultRule,
  FaultSchedule,
  IframeFault,
  LifecycleFault,
  LifecycleStage,
  RuntimeFault,
  StorageScope,
  UrlMatcher,
} from "./types.js";

export interface FaultHelperOptions {
  urlPattern: UrlMatcher;
  methods?: string[];
  probability?: number;
  /** Deterministic per-occurrence decisions. Mutually exclusive with `probability`. */
  schedule?: FaultSchedule;
  name?: string;
}

function applyCommon(rule: FaultRule, opts: FaultHelperOptions): FaultRule {
  rule.urlPattern = opts.urlPattern;
  if (opts.methods !== undefined) rule.methods = opts.methods;
  if (opts.probability !== undefined) rule.probability = opts.probability;
  if (opts.schedule !== undefined) rule.schedule = opts.schedule;
  if (opts.name !== undefined) rule.name = opts.name;
  return rule;
}

/** Common options accepted by every lifecycle fault helper. */
export interface LifecycleHelperOptions {
  /** Override the helper's default lifecycle stage. */
  when?: LifecycleStage;
  /** Restrict the fault to URLs matching this matcher. */
  urlPattern?: UrlMatcher;
  /** 0..1, default 1.0. Uses the crawler's seeded RNG. */
  probability?: number;
  /** Deterministic per-occurrence decisions. Mutually exclusive with `probability`. */
  schedule?: FaultSchedule;
  /** Override the auto-derived stats name. */
  name?: string;
}

function applyLifecycleCommon(
  fault: LifecycleFault,
  opts: LifecycleHelperOptions | undefined,
  defaultStage: LifecycleStage,
): LifecycleFault {
  fault.when = opts?.when ?? defaultStage;
  if (opts?.urlPattern !== undefined) fault.urlPattern = opts.urlPattern;
  if (opts?.probability !== undefined) fault.probability = opts.probability;
  if (opts?.schedule !== undefined) fault.schedule = opts.schedule;
  if (opts?.name !== undefined) fault.name = opts.name;
  return fault;
}

export const faults = {
  /** Respond with `status` (and optional body / content-type). */
  status(
    status: number,
    opts: FaultHelperOptions & { body?: string; contentType?: string }
  ): FaultRule {
    const rule: FaultRule = {
      urlPattern: opts.urlPattern,
      fault: {
        kind: "status",
        status,
        ...(opts.body !== undefined ? { body: opts.body } : {}),
        ...(opts.contentType !== undefined ? { contentType: opts.contentType } : {}),
      },
    };
    return applyCommon(rule, opts);
  },

  /**
   * Hold the request open without ever responding, so the caller's promise
   * never settles. Distinct from `delay`, which always eventually responds:
   * this is the "spinner forever" fault.
   *
   * `releaseAfterMs` aborts with `"timedout"` after that long. Without it
   * the request is held until the page closes — and because the crawler
   * navigates with `waitUntil: "networkidle"`, a hang on a navigation-time
   * request costs one page `timeout`. Prefer hanging what an action fires
   * after load, or pass `releaseAfterMs`.
   */
  hang(opts: FaultHelperOptions & { releaseAfterMs?: number }): FaultRule {
    if (
      opts.releaseAfterMs !== undefined &&
      (!Number.isFinite(opts.releaseAfterMs) || opts.releaseAfterMs < 0)
    ) {
      throw new Error(
        `faults.hang: releaseAfterMs must be a non-negative finite number (got ${opts.releaseAfterMs})`,
      );
    }
    const rule: FaultRule = {
      urlPattern: opts.urlPattern,
      fault: {
        kind: "hang",
        ...(opts.releaseAfterMs !== undefined ? { releaseAfterMs: opts.releaseAfterMs } : {}),
      },
    };
    return applyCommon(rule, opts);
  },

  /** Abort the request (e.g. to simulate a blocked third-party or transport failure). */
  abort(opts: FaultHelperOptions & { errorCode?: string }): FaultRule {
    const rule: FaultRule = {
      urlPattern: opts.urlPattern,
      fault: {
        kind: "abort",
        ...(opts.errorCode !== undefined ? { errorCode: opts.errorCode } : {}),
      },
    };
    return applyCommon(rule, opts);
  },

  /** Wait `ms` milliseconds, then continue the request unchanged. */
  delay(ms: number, opts: FaultHelperOptions): FaultRule {
    const rule: FaultRule = {
      urlPattern: opts.urlPattern,
      fault: { kind: "delay", ms },
    };
    return applyCommon(rule, opts);
  },

  /**
   * Apply CDP CPU throttling. `rate` is a multiplier ≥ 1 (1 = no throttle,
   * 4 = ~4× slower). Default stage is `beforeNavigation` so the load itself
   * is slowed.
   */
  cpu(rate: number, opts?: LifecycleHelperOptions): LifecycleFault {
    if (!Number.isFinite(rate) || rate < 1) {
      throw new Error(`faults.cpu: rate must be a finite number >= 1 (got ${rate})`);
    }
    const fault: LifecycleFault = {
      when: "beforeNavigation",
      action: { kind: "cpu-throttle", rate },
    };
    return applyLifecycleCommon(fault, opts, "beforeNavigation");
  },

  /**
   * Wipe the listed storage scopes. Cookies are cleared at the BrowserContext
   * level; `localStorage` / `sessionStorage` / `indexedDB` are cleared in-page.
   * Default stage is `afterLoad` so the page exists when the wipe runs.
   */
  clearStorage(
    opts: LifecycleHelperOptions & { scopes: StorageScope[] },
  ): LifecycleFault {
    if (!opts.scopes || opts.scopes.length === 0) {
      throw new Error("faults.clearStorage: at least one scope is required");
    }
    const fault: LifecycleFault = {
      when: "afterLoad",
      action: { kind: "clear-storage", scopes: [...opts.scopes] },
    };
    return applyLifecycleCommon(fault, opts, "afterLoad");
  },

  /**
   * Drop entries from the Service Worker `caches` API. With no `cacheNames`,
   * every cache is dropped. Default stage is `beforeActions` so the wipe
   * happens after invariants but before chaos clicks.
   */
  evictCache(
    opts?: LifecycleHelperOptions & { cacheNames?: string[] },
  ): LifecycleFault {
    const fault: LifecycleFault = {
      when: "beforeActions",
      action:
        opts?.cacheNames !== undefined
          ? { kind: "evict-cache", cacheNames: [...opts.cacheNames] }
          : { kind: "evict-cache" },
    };
    return applyLifecycleCommon(fault, opts, "beforeActions");
  },

  /**
   * Set a single key/value in `localStorage` or `sessionStorage`. Empty value
   * mimics a logged-out / token-cleared state without dropping unrelated keys.
   */
  tamperStorage(
    opts: LifecycleHelperOptions & {
      scope: "localStorage" | "sessionStorage";
      key: string;
      value: string;
    },
  ): LifecycleFault {
    const fault: LifecycleFault = {
      when: "afterLoad",
      action: {
        kind: "tamper-storage",
        scope: opts.scope,
        key: opts.key,
        value: opts.value,
      },
    };
    return applyLifecycleCommon(fault, opts, "afterLoad");
  },

  /**
   * Reject `window.fetch` calls before any network round-trip. Different
   * from `faults.abort()` (request-scoped, applied via Playwright `route`):
   * `flakyFetch` rejects the Promise client-side with a TypeError, so any
   * `try/catch` and Service-Worker fallbacks downstream of `fetch` engage
   * just like a real "Failed to fetch" event.
   */
  flakyFetch(opts?: RuntimeHelperOptions & { rejectionMessage?: string }): RuntimeFault {
    const fault: RuntimeFault = {
      action: {
        kind: "flaky-fetch",
        ...(opts?.rejectionMessage !== undefined
          ? { rejectionMessage: opts.rejectionMessage }
          : {}),
      },
    };
    return applyRuntimeCommon(fault, opts);
  },

  /**
   * Reject `window.fetch` with a chosen error shape — `"TypeError"`
   * (network failure, the default) or `"AbortError"` (a `DOMException`, what
   * an `AbortController` produces). Supersedes `flakyFetch`.
   */
  rejectFetch(
    opts?: RuntimeHelperOptions & {
      rejectAs?: "TypeError" | "AbortError";
      rejectionMessage?: string;
    },
  ): RuntimeFault {
    const fault: RuntimeFault = {
      action: {
        kind: "reject-fetch",
        ...(opts?.rejectAs !== undefined ? { rejectAs: opts.rejectAs } : {}),
        ...(opts?.rejectionMessage !== undefined
          ? { rejectionMessage: opts.rejectionMessage }
          : {}),
      },
    };
    return applyRuntimeCommon(fault, opts);
  },

  /**
   * Return a `fetch` promise that never settles, without issuing a request.
   * Surfaces missing timeouts even in code paths that never hit the network.
   */
  neverSettleFetch(opts?: RuntimeHelperOptions): RuntimeFault {
    const fault: RuntimeFault = { action: { kind: "never-settle-fetch" } };
    return applyRuntimeCommon(fault, opts);
  },

  /**
   * Let `fetch` resolve, then reject when the app reads the body
   * (`res.json()` by default). Catches the classic missed `catch`: error
   * handling wrapped around the fetch but not around `await res.json()`.
   */
  rejectBody(
    opts?: RuntimeHelperOptions & {
      consumers?: ReadonlyArray<"json" | "text" | "arrayBuffer" | "blob" | "formData">;
      rejectionMessage?: string;
    },
  ): RuntimeFault {
    const fault: RuntimeFault = {
      action: {
        kind: "reject-body",
        ...(opts?.consumers !== undefined ? { consumers: opts.consumers } : {}),
        ...(opts?.rejectionMessage !== undefined
          ? { rejectionMessage: opts.rejectionMessage }
          : {}),
      },
    };
    return applyRuntimeCommon(fault, opts);
  },

  /**
   * Resolve `fetch` with a rejecting thenable instead of rejecting
   * directly: same outcome, one microtask later, via the spec's
   * assimilation path. Exposes handlers attached too late.
   */
  rejectedThenable(
    opts?: RuntimeHelperOptions & { rejectionMessage?: string },
  ): RuntimeFault {
    const fault: RuntimeFault = {
      action: {
        kind: "resolve-rejected-thenable",
        ...(opts?.rejectionMessage !== undefined
          ? { rejectionMessage: opts.rejectionMessage }
          : {}),
      },
    };
    return applyRuntimeCommon(fault, opts);
  },

  /**
   * Skew `Date.now()`, `performance.now()`, and the no-arg `Date`
   * constructor forward by `skewMs`. Use to surface token-expiry,
   * cache-bust, and "clock drift" code paths without waiting real time.
   */
  clockSkew(skewMs: number, opts?: RuntimeHelperOptions): RuntimeFault {
    if (!Number.isFinite(skewMs) || !Number.isInteger(skewMs)) {
      throw new Error(`faults.clockSkew: skewMs must be a finite integer (got ${skewMs})`);
    }
    const fault: RuntimeFault = { action: { kind: "clock-skew", skewMs } };
    return applyRuntimeCommon(fault, opts);
  },

  /**
   * Delay an iframe's contained-document load by `ms` ms. Wraps the iframe's
   * `src` assignment in `setTimeout(ms)` so the parent's `iframe.onload`
   * fires that much later. Different from `faults.delay()` (which slows the
   * iframe's *inside* document) — `iframeLoadDelay` slows the iframe
   * **element's own load** as observed by the parent page, including code
   * paths that race a timer against `iframe.onload`.
   */
  iframeLoadDelay(ms: number, opts: IframeHelperOptions): IframeFault {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(`faults.iframeLoadDelay: ms must be a non-negative finite number (got ${ms})`);
    }
    const fault: IframeFault = {
      selector: opts.selector,
      action: { kind: "load-delay", ms },
    };
    return applyIframeCommon(fault, opts);
  },

  /**
   * Swap a matching iframe's `src` to `about:blank` and never assign the
   * real URL. Useful for testing host-library code paths that wait on
   * `iframe.onload` to fire impression / no-fill / timeout events when the
   * contained document never arrives.
   */
  iframeNeverLoad(opts: IframeHelperOptions): IframeFault {
    const fault: IframeFault = {
      selector: opts.selector,
      action: { kind: "never-load" },
    };
    return applyIframeCommon(fault, opts);
  },

  /**
   * Assign the real `src`, then `iframe.remove()` after `atMs` ms.
   * Simulates the user closing an overlay or the host library cleaning up
   * mid-load — exercises listener-teardown and pending-callback races.
   */
  iframeRemoveMidLoad(opts: IframeHelperOptions & { atMs: number }): IframeFault {
    if (!Number.isFinite(opts.atMs) || opts.atMs < 0) {
      throw new Error(
        `faults.iframeRemoveMidLoad: atMs must be a non-negative finite number (got ${opts.atMs})`,
      );
    }
    const fault: IframeFault = {
      selector: opts.selector,
      action: { kind: "remove-mid-load", atMs: opts.atMs },
    };
    return applyIframeCommon(fault, opts);
  },
};

export interface RuntimeHelperOptions {
  /** Restrict the fault to pages whose URL matches this matcher. */
  urlPattern?: UrlMatcher;
  /** 0..1, default 1.0. Rolled per call against the in-page seeded RNG. */
  probability?: number;
  /** Deterministic per-occurrence decisions. Mutually exclusive with `probability`. */
  schedule?: FaultSchedule;
  /** Override the auto-derived stats name. */
  name?: string;
}

function applyRuntimeCommon(
  fault: RuntimeFault,
  opts: RuntimeHelperOptions | undefined,
): RuntimeFault {
  if (opts?.urlPattern !== undefined) fault.urlPattern = opts.urlPattern;
  if (opts?.probability !== undefined) fault.probability = opts.probability;
  if (opts?.schedule !== undefined) fault.schedule = opts.schedule;
  if (opts?.name !== undefined) fault.name = opts.name;
  return fault;
}

/** Common options accepted by every iframe-fault helper. */
export interface IframeHelperOptions {
  /**
   * CSS selector applied to each iframe element at the moment its `src` is
   * set. Matched via `iframe.matches(selector)`, so ancestor combinators
   * (`#container iframe`) only fire if the iframe is already attached to
   * the DOM when `src` is assigned. Attribute / class selectors on the
   * iframe itself are more robust.
   */
  selector: string;
  /** 0..1, default 1.0. Rolled per call against the in-page seeded RNG. */
  probability?: number;
  /** Deterministic per-occurrence decisions. Mutually exclusive with `probability`. */
  schedule?: FaultSchedule;
  /** Override the auto-derived stats name. */
  name?: string;
}

function applyIframeCommon(
  fault: IframeFault,
  opts: IframeHelperOptions,
): IframeFault {
  if (typeof opts.selector !== "string" || opts.selector.length === 0) {
    throw new Error("faults.iframe*: selector must be a non-empty string");
  }
  if (opts.probability !== undefined) fault.probability = opts.probability;
  if (opts.schedule !== undefined) fault.schedule = opts.schedule;
  if (opts.name !== undefined) fault.name = opts.name;
  return fault;
}
