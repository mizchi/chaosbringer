/**
 * Public types for @mizchi/kitesurf-faults.
 *
 * The rule shapes are `@mizchi/playwright-faults`' own, re-exported rather
 * than redeclared: a rule written for Chromium is the same value here, and a
 * second declaration is how the two drift apart.
 */

import type { FaultInjectionStats, FaultRule } from "@mizchi/playwright-faults";

export type { Fault, FaultInjectionStats, FaultRule, FaultSchedule } from "@mizchi/playwright-faults";

/**
 * Anything with `fetch(request): Promise<Response>`.
 *
 * Kitesurf's `EngineHost.egress` takes this shape, as does a Workers Service
 * Binding and `globalThis` itself. Matched structurally so the package never
 * imports a Kitesurf or Workers type.
 */
export interface FetchTransport {
  fetch(request: Request): Promise<Response>;
}

export interface FaultEgressOptions {
  /** Checked and copied at construction; the caller's values are not kept. */
  rules: readonly FaultRule[];
  /**
   * Seed for the rules that use `probability`. A uint32 integer, required:
   * a session with a random seed cannot be replayed, and a seed outside
   * uint32 would be truncated into a different run without saying so.
   */
  seed: number;
  /**
   * Largest `delay.ms` a rule may ask for. Default and ceiling 5000: the
   * engine gives a request 10 s to produce headers, and a longer delay tests
   * the engine's timeout rather than the page.
   */
  maxDelayMs?: number;
}

export interface FaultEgressSession extends FetchTransport {
  /** Per-rule counters, as fresh objects on every call. Works after `dispose()`. */
  stats(): FaultInjectionStats[];
  /**
   * End the session: pending delays and upstream calls in flight are
   * aborted, and every later `fetch` rejects. Safe to call more than once.
   */
  dispose(): Promise<void>;
}
