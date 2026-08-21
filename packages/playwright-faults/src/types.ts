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

/** One occurrence's verdict in a `FaultSchedule`. */
export type FaultDecision = "pass" | "inject";

/**
 * Deterministic replacement for `probability`: a decision table indexed by
 * how many times the fault has already matched (occurrence 0, 1, 2, …).
 *
 * Understood by all four fault layers. Mutually exclusive with
 * `probability` — setting both throws at compile time. Evaluated by
 * `decideFault` (Node-side layers) or its generated in-page twin.
 */
export interface FaultSchedule {
  /** Verdict for occurrence 0, 1, 2, … */
  decisions: ReadonlyArray<FaultDecision>;
  /**
   * Behaviour past the end of `decisions`. Default `"pass"` (spent).
   * `"inject"` keeps firing; `"repeat"` cycles the table.
   */
  afterEnd?: "pass" | "inject" | "repeat";
}

// =====================================================================
// 1. Network-level fault injection (Playwright route())
// =====================================================================

/** What to do when a FaultRule matches a request. */
export type Fault =
  | { kind: "abort"; errorCode?: string }
  | { kind: "status"; status: number; body?: string; contentType?: string }
  | { kind: "delay"; ms: number }
  /**
   * Hold the request open and never respond — the request stays in flight,
   * so the caller's promise never settles. Exposes spinners with no timeout
   * and `Promise.all` chains that can never resolve; `delay` cannot, because
   * it always eventually responds.
   *
   * `releaseAfterMs` aborts with `"timedout"` after that long. Omit it to
   * hold until the page closes — but note the crawler navigates with
   * `waitUntil: "networkidle"`, so a hang on a request issued *during*
   * navigation costs one `timeout` per page visit — and the resulting
   * `page.goto` rejection is recorded as a page error of type `exception`,
   * which shows up in `summary.jsExceptions` even though the page threw
   * nothing. That is the expected outcome of this fault, not a finding.
   * Prefer hanging requests
   * that an action fires after load, or set `releaseAfterMs`.
   */
  | { kind: "hang"; releaseAfterMs?: number };

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
  /**
   * Deterministic per-occurrence decisions, e.g. `{ decisions: ["inject",
   * "pass"] }` to fail the first matching request and let the retry through.
   * Mutually exclusive with `probability`.
   */
  schedule?: FaultSchedule;
}

/** Per-rule stats for fault injection, emitted on the final report. */
export interface FaultInjectionStats {
  rule: string;
  matched: number;
  injected: number;
  /**
   * Times this rule's schedule said "inject" and an earlier rule had already
   * claimed the request. Present only when non-zero.
   *
   * Rules are first-match-wins, but a *scheduled* rule advances its
   * occurrence whenever its pattern matches — two rules watching one URL have
   * to agree on what occurrence 1 means. So a scheduled rule can decide
   * "inject" and still do nothing. Without this number that shows up as
   * `matched: 3, injected: 0`, which is exactly what an all-`pass` schedule
   * reports: a planned fault that did not happen, indistinguishable from one
   * that was never planned.
   */
  suppressed?: number;
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
  /**
   * Deterministic per-occurrence decisions. Occurrence counts page visits
   * whose URL matched. Mutually exclusive with `probability`.
   */
  schedule?: FaultSchedule;
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
   *
   * @deprecated Use `reject-fetch`, which is the same thing with a
   * selectable error shape. `flaky-fetch` keeps working indefinitely.
   */
  | { kind: "flaky-fetch"; rejectionMessage?: string }
  /**
   * Reject `window.fetch` with a chosen error shape.
   *
   * `rejectAs: "TypeError"` (default) is the network-failure shape.
   * `rejectAs: "AbortError"` throws a `DOMException` named `AbortError` —
   * what an `AbortController` produces. Code that only inspects
   * `err instanceof TypeError`, or that treats every rejection as a network
   * outage and shows a retry banner on a user-initiated cancel, breaks on
   * exactly one of the two.
   */
  | {
      kind: "reject-fetch";
      rejectAs?: "TypeError" | "AbortError";
      rejectionMessage?: string;
    }
  /**
   * Return a promise from `window.fetch` that never settles, without
   * issuing a request. The client-side twin of the network `hang` fault:
   * no route matches, nothing is in flight, and `await fetch(...)` simply
   * never returns. Exposes missing timeouts in code that never reaches the
   * network (Service Worker / cache layers included).
   *
   * An `init.signal` is still honoured — the promise rejects when the caller
   * aborts, exactly as a real hung request does. So an app that bounds its
   * requests with `AbortController` / `AbortSignal.timeout` survives this
   * fault, and only one that cannot cancel is left hanging.
   */
  | { kind: "never-settle-fetch" }
  /**
   * Let `fetch` resolve normally, then reject when the app consumes the
   * body (`res.json()` by default).
   *
   * This is the most commonly missed `catch` in real code: the fetch is
   * wrapped in try/catch or `.catch()`, but `await res.json()` sits outside
   * it, so a truncated / non-JSON body escapes as an unhandled rejection
   * even though the app "handles fetch errors".
   */
  | {
      kind: "reject-body";
      /** Which consumers reject. Default: `["json"]`. */
      consumers?: ReadonlyArray<"json" | "text" | "arrayBuffer" | "blob" | "formData">;
      rejectionMessage?: string;
    }
  /**
   * Resolve `fetch` with a *thenable* that rejects, instead of rejecting
   * directly. The promise still ends up rejected, but one microtask later
   * and via the spec's thenable-assimilation path — which is where
   * "handler attached too late" bugs live (a `.catch()` added in a
   * `setTimeout`, or a rejection that beats its own handler registration).
   */
  | { kind: "resolve-rejected-thenable"; rejectionMessage?: string }
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
   * URL matcher, evaluated inside the page — so it must be
   * JSON-serializable (a string regex or a RegExp literal). Omitted =
   * always applies.
   *
   * **What it is matched against depends on the action:**
   * - fetch-scoped kinds (`flaky-fetch`, `reject-fetch`,
   *   `never-settle-fetch`, `reject-body`, `resolve-rejected-thenable`)
   *   match the **request URL** passed to `fetch()`, per call.
   * - page-scoped kinds (`clock-skew`) match `location.href` once, when
   *   the init script installs.
   */
  urlPattern?: UrlMatcher;
  /** 0..1, default 1.0. Rolled per call against an in-page seeded RNG. */
  probability?: number;
  /**
   * HTTP methods to match (case-insensitive), for fetch-scoped kinds.
   * Omitted = every method. Needed whenever one URL carries more than one
   * operation — `GET /api/todos` and `POST /api/todos` are different
   * operations that a URL pattern alone cannot tell apart.
   */
  methods?: string[];
  /**
   * Deterministic per-occurrence decisions, evaluated in-page. Occurrence
   * counts matching calls (e.g. `fetch()` invocations whose URL and method
   * matched) within one page load — the counter resets on navigation,
   * because the init script is re-installed in the new frame. Mutually
   * exclusive with `probability`.
   */
  schedule?: FaultSchedule;
  /** What to do when the fault fires. */
  action: RuntimeAction;
}

/** Per-fault stats for runtime fault injection, emitted on the final report. */
export interface RuntimeFaultStats {
  /** `name` from the `RuntimeFault`, or an auto-derived label. */
  rule: string;
  /** Times the fault was tested (URL matched, probability about to roll). */
  matched: number;
  /**
   * Times the fault actually took effect — the call it answered. A scheduled
   * fault that decided "inject" while an earlier fault was already answering
   * the call is counted in `suppressed`, not here: it decided, it did not act,
   * and a consumer reading `fired` on a `never-settle-fetch` concludes the
   * page is hanging.
   */
  fired: number;
  /**
   * Times this fault decided "inject" and another fault answered the call
   * instead. Present only when non-zero. See `FaultInjectionStats.suppressed`
   * — the network layer's counterpart — for why the decision is consumed even
   * when it cannot be acted on.
   */
  suppressed?: number;
}

// =====================================================================
// 4. Iframe-load fault injection (Playwright addInitScript)
// =====================================================================

/**
 * What an iframe-load fault does when it fires.
 *
 * Implemented by monkey-patching `HTMLIFrameElement.prototype` so the fault
 * fires at the moment the host page sets the iframe's `src` — distinct from
 * `FaultRule` (request-scoped, observable only inside the iframe's contained
 * document) and `LifecycleFault` (one-shot at host-page lifecycle stages).
 */
export type IframeAction =
  /**
   * Delay the iframe's contained document load by `ms` milliseconds. The
   * `src` assignment is queued and resolved after the timeout — the parent
   * page's `iframe.onload` fires `ms` ms later than it normally would.
   */
  | { kind: "load-delay"; ms: number }
  /**
   * Swap the iframe's `src` to `about:blank` and never assign the real URL.
   * The iframe's `load` event still fires (about:blank loads), but the host
   * library's onload-driven impression / no-fill logic sees a blank document.
   */
  | { kind: "never-load" }
  /**
   * Set the real URL, then remove the iframe from the DOM after `atMs`.
   * Simulates a user closing the overlay / host-library cleanup races.
   */
  | { kind: "remove-mid-load"; atMs: number };

/**
 * Per-iframe-load fault, applied via an in-page monkey-patch of
 * `HTMLIFrameElement.prototype`. The fault matches by CSS selector against
 * the iframe element at the moment its `src` is set.
 *
 * Distinct from `FaultRule` (request-scoped, applied via Playwright `route`),
 * `LifecycleFault` (host-page stages), and `RuntimeFault` (in-page JS APIs).
 */
export interface IframeFault {
  /** Optional human-readable name used in stats. Auto-derived when omitted. */
  name?: string;
  /**
   * CSS selector applied to each iframe at the moment its `src` is set. The
   * matcher uses `iframe.matches(selector)`, so ancestor combinators (e.g.
   * `#container iframe`) only match if the iframe is already in the DOM when
   * its `src` is assigned. Prefer attribute / class selectors on the iframe
   * itself (e.g. `iframe[data-widget]`, `iframe.ad-slot`) for libraries that
   * assign `src` before `appendChild`.
   */
  selector: string;
  /** 0..1, default 1.0. Rolled per call against an in-page seeded RNG. */
  probability?: number;
  /**
   * Deterministic per-occurrence decisions, evaluated in-page. Occurrence
   * counts iframes matching `selector` whose `src` was assigned during this
   * page load. Mutually exclusive with `probability`.
   */
  schedule?: FaultSchedule;
  /** What to do when the fault fires. */
  action: IframeAction;
}

/** Per-fault stats for iframe-load fault injection, emitted on the final report. */
export interface IframeFaultStats {
  /** `name` from the `IframeFault`, or an auto-derived label. */
  rule: string;
  /** The selector the fault was registered with. */
  selector: string;
  /** Action kind from the fault. */
  action: "load-delay" | "never-load" | "remove-mid-load";
  /** Iframes whose selector matched (probability not yet rolled). */
  matched: number;
  /** Iframes the fault actually fired on (after the probability roll). */
  fired: number;
}
