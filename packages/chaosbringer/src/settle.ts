/**
 * Adaptive settle: wait until the page has actually gone quiet, instead of
 * paying a fixed `networkidle` window per step (design §6.1).
 *
 * What `networkidle` really does in the crawler, measured rather than assumed:
 *
 *   - after `page.goto` it waits for 500 ms with no network connections, so
 *     every page load pays at least 500 ms after its last request;
 *   - after a click, `page.waitForLoadState("networkidle")` resolves at once
 *     when the current document has *already* reached networkidle — which it
 *     has, since the load waited for it. So a click that only fires an XHR
 *     (no navigation) does not wait for that XHR at all; what the next step
 *     sees is decided by the fixed 100 ms pause and how long target
 *     collection happens to take, not by the request.
 *
 * Adaptive settle resolves when, at once:
 *
 *   - no request of this page has been in flight for `quietMs`;
 *   - no long task ended in the last `quietMs`;
 *   - at least two animation frames have run since the settle began (the
 *     page has had a chance to render what the step caused);
 *
 * and gives up at a cap — the old timeouts: the navigation `timeout` after a
 * load, 2000 ms after an action. Hitting the cap is not an error. It is
 * reported (`capped`), because a step that never quiesces is itself a finding.
 *
 * Opt-in, permanently (§10): the default stays `networkidle`, so existing
 * crawls, recorded traces and calibrated `TimingProfile`s keep their timing.
 *
 * The decision is a pure function (`decideSettle`) and the loop around it
 * takes its clock, its in-page probe and its wait as arguments, so the state
 * machine is tested without a browser.
 */

import type { PerfWindow } from "lightbringer/core";
import type { Page, Request } from "playwright";
import { raceTimeout, TIMED_OUT } from "./async-util.js";
import type { SettleMode } from "./types.js";

export type { SettleMode };

/** Quiet window when `settle: "adaptive"` names none. */
export const DEFAULT_SETTLE_QUIET_MS = 100;
/**
 * Cap for the settle after an action: the old post-click
 * `waitForLoadState("networkidle", { timeout: 2000 })`.
 */
export const ACTION_SETTLE_CAP_MS = 2000;
/** Animation frames that must run after the step before it counts as settled. */
export const SETTLE_MIN_FRAMES = 2;
/**
 * Longest single wait between probes while a request is in flight. Network
 * events wake the loop early, so this only bounds how late a request that
 * crossed its staleness age (see `RequestTracker.inflight`) is noticed.
 */
const MAX_IDLE_WAIT_MS = 250;
/** Back-off after a probe hit a document that was being replaced. */
const NAVIGATION_RETRY_MS = 16;

export type ResolvedSettle =
  | { mode: "networkidle" }
  | { mode: "adaptive"; quietMs: number };

/**
 * Validate a `settle` value. Every message starts with `chaosbringer:` and
 * names the option, like the rest of `validateOptions`.
 *
 * A quiet window at or above the action cap is refused: every action would
 * hit the cap by construction, which reads as "the app never quiesces" on
 * every step while measuring nothing about the app.
 */
export function validateSettle(value: unknown): void {
  if (value === undefined || value === "networkidle" || value === "adaptive") return;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value >= ACTION_SETTLE_CAP_MS) {
      throw new Error(
        `chaosbringer: "settle" as a number is the adaptive quiet window in ms and must be an ` +
          `integer in [0, ${ACTION_SETTLE_CAP_MS}) (got ${JSON.stringify(value)}); a window at ` +
          `or above the ${ACTION_SETTLE_CAP_MS} ms action cap would cap every step`,
      );
    }
    return;
  }
  throw new Error(
    `chaosbringer: "settle" must be "networkidle", "adaptive" or a quiet window in ms ` +
      `(got ${JSON.stringify(value)})`,
  );
}

/** `settle` option → what the crawler does. Assumes `validateSettle` passed. */
export function resolveSettle(value: SettleMode | undefined): ResolvedSettle {
  if (value === undefined || value === "networkidle") return { mode: "networkidle" };
  if (value === "adaptive") return { mode: "adaptive", quietMs: DEFAULT_SETTLE_QUIET_MS };
  return { mode: "adaptive", quietMs: value };
}

/**
 * Parse `--settle <networkidle|adaptive|ms>`. Throws the same message
 * `validateSettle` would, so the CLI and the option agree on what is legal.
 */
export function parseSettleArg(raw: string): SettleMode {
  const trimmed = raw.trim();
  if (trimmed === "networkidle" || trimmed === "adaptive") return trimmed;
  // `Number("")` is 0, which would turn `--settle ""` into a 0 ms window.
  const n = trimmed === "" ? Number.NaN : Number(trimmed);
  if (Number.isNaN(n)) {
    throw new Error(
      `chaosbringer: --settle must be networkidle, adaptive or a quiet window in ms (got ${JSON.stringify(raw)})`,
    );
  }
  validateSettle(n);
  return n;
}

/** The `--settle` value that reproduces `value`, or null for the default. */
export function settleReproArg(value: SettleMode | undefined): string | null {
  if (value === undefined || value === "networkidle") return null;
  return String(value);
}

/**
 * In-flight requests of one page, kept for the page's whole visit.
 *
 * It has to exist before the step it settles: a request the page started
 * before the settle began and that is still running is exactly what the
 * settle must wait for, and events alone cannot tell the loop about it.
 *
 * Page-level events only (`page.on`, not the context's), so a request of
 * another page in the context never holds this one. EventSource streams are
 * not counted — they are open by design, and would cap every step of a page
 * that uses one. Nor is a request older than the settle's own cap: a request
 * that has been open that long already capped the settle it started in, and
 * holding every later step on it too would turn one hung request into a
 * 2 s tax on the rest of the page. That is also what keeps a `hang` fault's
 * parked route (released only by `drainHeldRoutes` when the page is done)
 * from capping more than the step that fired it.
 */
export class RequestTracker {
  private readonly open = new Map<unknown, number>();
  private lastActivity = Number.NEGATIVE_INFINITY;
  private waiters: Array<() => void> = [];

  constructor(private readonly now: () => number) {}

  /** A request of this page started. `key` is anything unique per request. */
  started(key: unknown): void {
    this.open.set(key, this.now());
    this.touch();
  }

  /** A request finished or failed. Unknown keys still count as activity. */
  ended(key: unknown): void {
    this.open.delete(key);
    this.touch();
  }

  /**
   * Requests still open at `now` and younger than `maxAgeMs`, plus when the
   * network last changed. A request that aged out counts as having ended at
   * the moment it did, so the quiet window restarts from there rather than
   * from its start.
   *
   * With `settle` (the running settle's start and cap), a request that was
   * not yet stale when the settle began counts until that cap, not just until
   * `startedAt + maxAgeMs`. Otherwise one that started before the settle —
   * every load-time request, since the load settle begins only after
   * `page.goto` returns — would age out shortly before the cap, leave a quiet
   * window, and let a settle that waited out nearly the whole cap on a hung
   * request report itself as not capped. A request already stale at the
   * settle's start stays excluded, which is what keeps one hung request from
   * capping every later step.
   */
  inflight(
    now: number,
    maxAgeMs: number,
    settle?: { start: number; capAt: number },
  ): { count: number; lastActivity: number } {
    let count = 0;
    let lastActivity = this.lastActivity;
    for (const startedAt of this.open.values()) {
      let agedOutAt = startedAt + maxAgeMs;
      if (settle && agedOutAt > settle.start) agedOutAt = Math.max(agedOutAt, settle.capAt);
      if (now < agedOutAt) count++;
      else if (agedOutAt > lastActivity) lastActivity = agedOutAt;
    }
    return { count, lastActivity };
  }

  /** Resolve after `ms`, or earlier on the next network event. */
  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      this.waiters.push(done);
    });
  }

  private touch(): void {
    this.lastActivity = this.now();
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }
}

/**
 * Attach a `RequestTracker` to `page`'s request events. Returns it and the
 * detach function; the crawler detaches before the page is closed or handed
 * back, like its other per-page listeners.
 */
export function trackPageRequests(
  page: Page,
  now: () => number = () => performance.now(),
): { tracker: RequestTracker; detach: () => void } {
  const tracker = new RequestTracker(now);
  const onRequest = (req: Request): void => {
    if (req.resourceType() === "eventsource") return;
    tracker.started(req);
  };
  const onEnd = (req: Request): void => tracker.ended(req);
  page.on("request", onRequest);
  page.on("requestfinished", onEnd);
  page.on("requestfailed", onEnd);
  return {
    tracker,
    detach: () => {
      page.off("request", onRequest);
      page.off("requestfinished", onEnd);
      page.off("requestfailed", onEnd);
    },
  };
}

/** What one in-page probe saw. */
export type SettleProbe =
  /** `longTaskAgeMs`: ms since the latest long task ended; null when none is known. */
  | { kind: "ok"; longTaskAgeMs: number | null }
  /** The main thread did not answer in time. */
  | { kind: "timeout" }
  /** The document was replaced mid-probe; a navigation is under way. */
  | { kind: "navigated" }
  /** The page is closed. */
  | { kind: "gone" };

/** Everything `decideSettle` needs, all times on one clock. */
export interface SettleSnapshot {
  now: number;
  capAt: number;
  quietMs: number;
  inflight: number;
  lastNetworkActivity: number;
  lastLongTaskEnd: number;
  framesDone: boolean;
}

export type SettleDecision =
  | { kind: "settled" }
  | { kind: "capped"; reason: SettleCapReason }
  /** Probe again after `ms` (a network event may wake the loop sooner). */
  | { kind: "wait"; ms: number };

/** What was still going on when a settle hit its cap. */
export type SettleCapReason = "inflight" | "long-task" | "frames" | "busy";

/** The settle state machine: one decision from one snapshot. */
export function decideSettle(s: SettleSnapshot): SettleDecision {
  const remaining = s.capAt - s.now;
  const quietAt = Math.max(s.lastNetworkActivity, s.lastLongTaskEnd) + s.quietMs;
  if (s.framesDone && s.inflight === 0 && s.now >= quietAt) return { kind: "settled" };
  if (remaining <= 0) {
    const reason: SettleCapReason = !s.framesDone
      ? "frames"
      : s.inflight > 0 || s.lastNetworkActivity >= s.lastLongTaskEnd
        ? "inflight"
        : "long-task";
    return { kind: "capped", reason };
  }
  if (!s.framesDone) return { kind: "wait", ms: 0 };
  if (s.inflight > 0) return { kind: "wait", ms: Math.min(remaining, MAX_IDLE_WAIT_MS) };
  return { kind: "wait", ms: Math.min(remaining, quietAt - s.now) };
}

export interface SettleEnv {
  now(): number;
  /**
   * One in-page read. With `frames`, it first waits for `SETTLE_MIN_FRAMES`
   * animation frames. It must answer within `timeoutMs`, with
   * `{ kind: "timeout" }` if the page does not.
   */
  probe(frames: boolean, timeoutMs: number): Promise<SettleProbe>;
  /** Wait up to `ms`, returning early on network activity. */
  wait(ms: number): Promise<void>;
}

export interface SettleOutcome {
  capped: boolean;
  /** Set when `capped`: what the page was still doing at the cap. */
  reason?: SettleCapReason;
  elapsedMs: number;
}

/**
 * Settle one step. Never throws and never outlives `capMs` by more than one
 * probe's scheduling slack: every probe is bounded by the time remaining.
 */
export async function settleAdaptive(
  tracker: RequestTracker,
  env: SettleEnv,
  { quietMs, capMs }: { quietMs: number; capMs: number },
): Promise<SettleOutcome> {
  const start = env.now();
  const capAt = start + Math.max(0, capMs);
  let framesDone = false;
  let lastLongTaskEnd = Number.NEGATIVE_INFINITY;
  let lastNavigation = Number.NEGATIVE_INFINITY;

  for (;;) {
    const remaining = capAt - env.now();
    if (remaining <= 0) {
      return capped(framesDone ? decideAt() : "frames");
    }
    const probe = await env.probe(!framesDone, remaining);
    const probedAt = env.now();
    if (probe.kind === "gone") return { capped: false, elapsedMs: probedAt - start };
    if (probe.kind === "timeout") return capped("busy");
    if (probe.kind === "navigated") {
      // The new document has to render its own frames, and the swap itself
      // is activity: the quiet window restarts from here.
      framesDone = false;
      lastNavigation = probedAt;
      await env.wait(Math.min(NAVIGATION_RETRY_MS, Math.max(0, capAt - probedAt)));
      continue;
    }
    framesDone = true;
    if (probe.longTaskAgeMs !== null) {
      lastLongTaskEnd = Math.max(lastLongTaskEnd, probedAt - probe.longTaskAgeMs);
    }
    const net = tracker.inflight(probedAt, capMs, { start, capAt });
    const decision = decideSettle({
      now: probedAt,
      capAt,
      quietMs,
      inflight: net.count,
      lastNetworkActivity: Math.max(net.lastActivity, lastNavigation),
      lastLongTaskEnd,
      framesDone,
    });
    if (decision.kind === "settled") return { capped: false, elapsedMs: probedAt - start };
    if (decision.kind === "capped") return capped(decision.reason);
    await env.wait(decision.ms);
  }

  function decideAt(): SettleCapReason {
    const net = tracker.inflight(env.now(), capMs, { start, capAt });
    return net.count > 0 || Math.max(net.lastActivity, lastNavigation) >= lastLongTaskEnd
      ? "inflight"
      : "long-task";
  }
  function capped(reason: SettleCapReason): SettleOutcome {
    return { capped: true, reason, elapsedMs: env.now() - start };
  }
}

/**
 * The in-page probe on a real page.
 *
 * Long tasks come from the always-on collector's store, read without
 * draining it (`flush()` only moves pending observer records *into* the
 * store): a span that closes later still gets every task. The collector's
 * native clock is used rather than `performance.now()`, which page script or
 * a runtime fault may have replaced. Without the collector — a caller's page
 * on the `testPage()` path with perf off — long tasks are unknown, and the
 * probe itself is the check: it cannot run while the main thread is busy.
 *
 * Frames are skipped on a hidden document, where the browser does not run
 * animation frames at all and waiting for them would cap every step.
 */
export function pageSettleEnv(page: Page, tracker: RequestTracker): SettleEnv {
  return {
    now: () => performance.now(),
    wait: (ms) => tracker.wait(ms),
    async probe(frames, timeoutMs) {
      if (page.isClosed()) return { kind: "gone" };
      const read = page
        .evaluate(async (minFrames) => {
          if (minFrames > 0 && document.visibilityState !== "hidden") {
            for (let i = 0; i < minFrames; i++) {
              await new Promise((r) => requestAnimationFrame(() => r(null)));
            }
          }
          const store = (window as unknown as PerfWindow).__perf;
          if (!store || store.__lb !== true) return null;
          store.flush?.();
          let lastEnd = Number.NEGATIVE_INFINITY;
          for (const t of store.longTasks) lastEnd = Math.max(lastEnd, t.start + t.duration);
          if (lastEnd === Number.NEGATIVE_INFINITY) return null;
          // Long-task times are on this document's native timeline;
          // `store.now()` is native epoch ms, so subtract the origin.
          const nowRel = store.now
            ? store.now() - performance.timeOrigin
            : performance.now();
          return Math.max(0, nowRel - lastEnd);
        }, frames ? SETTLE_MIN_FRAMES : 0)
        .then(
          (age): SettleProbe => ({ kind: "ok", longTaskAgeMs: age }),
          (): SettleProbe => (page.isClosed() ? { kind: "gone" } : { kind: "navigated" }),
        );
      const outcome = await raceTimeout(read, Math.max(0, timeoutMs));
      return outcome === TIMED_OUT ? { kind: "timeout" } : outcome;
    },
  };
}
