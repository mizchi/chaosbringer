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
  LifecycleFault,
  LifecycleStage,
  StorageScope,
  UrlMatcher,
} from "./types.js";

export interface FaultHelperOptions {
  urlPattern: UrlMatcher;
  methods?: string[];
  probability?: number;
  name?: string;
}

function applyCommon(rule: FaultRule, opts: FaultHelperOptions): FaultRule {
  rule.urlPattern = opts.urlPattern;
  if (opts.methods !== undefined) rule.methods = opts.methods;
  if (opts.probability !== undefined) rule.probability = opts.probability;
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
};
