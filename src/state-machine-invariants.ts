/**
 * State-machine invariant preset.
 *
 * Builds on the run-scoped `InvariantContext.state` Map shared by every
 * invariant on every page. The preset compiles down to an ordinary
 * `Invariant` whose `check()`:
 *
 *   1. Reads the previous state label from `ctx.state` (under a key derived
 *      from the SM's `name`). Falls back to `initial` on the first call of
 *      a run.
 *   2. Calls `derive({ page, url, prev, errors })` to get the new label.
 *   3. Returns `void` when the label hasn't changed (still in the same
 *      state).
 *   4. When the label changed, validates the transition against the
 *      `transitions` map — `prev` must list `next` in its allowed-next list.
 *   5. On a legal transition, updates the state and returns `void`.
 *   6. On an illegal transition, returns a one-line failure string. The
 *      crawler turns that into an `invariant-violation` PageError as usual.
 *
 * Use this for discrete app modes (anonymous → logged-in → in-checkout →
 * purchased). For non-discrete trans-page properties (monotonic counters,
 * set-membership), drop down to a plain `Invariant` and use `ctx.state`
 * directly.
 */

import type { Invariant, InvariantContext, UrlMatcher } from "./types.js";

export interface StateMachineDeriveContext<S extends string> {
  /** Playwright Page. */
  page: InvariantContext["page"];
  /** Current page URL. */
  url: string;
  /** State label from the previous derive — `initial` on the first call. */
  prev: S;
  /** Errors collected on this page so far. */
  errors: InvariantContext["errors"];
}

export interface StateMachineInvariantOptions<S extends string> {
  /** Identifier — used as the failure name and the state-bag key. */
  name: string;
  /** State label assumed before the first derive in a run. */
  initial: S;
  /**
   * Map from each state label to the labels you can legally transition to.
   * Self-loops (`next === prev`) are always allowed and don't need to appear.
   * A state with no outgoing edges (terminal) is fine — list it as `[]` or
   * leave it out entirely; arriving there is legal, leaving is not.
   */
  transitions: Partial<Record<S, readonly S[]>>;
  /**
   * Compute the current state label from the page. Throws / rejects fail the
   * invariant with the error message, same as any other invariant.
   */
  derive: (ctx: StateMachineDeriveContext<S>) => S | Promise<S>;
  /** Phase to evaluate. Default: `afterActions`. */
  when?: Invariant["when"];
  /** Restrict to URLs matching this matcher. */
  urlPattern?: UrlMatcher;
}

export interface TransitionVerdict<S extends string> {
  ok: boolean;
  prev: S;
  next: S;
  /** When `ok === false`, a one-line explanation. */
  reason?: string;
}

/**
 * Pure helper: decide whether a transition `prev → next` is legal under the
 * given `transitions` map. Self-loops (`next === prev`) are always legal.
 */
export function validateTransition<S extends string>(
  prev: S,
  next: S,
  transitions: Partial<Record<S, readonly S[]>>,
): TransitionVerdict<S> {
  if (next === prev) return { ok: true, prev, next };
  const allowed = transitions[prev];
  if (!allowed) {
    return {
      ok: false,
      prev,
      next,
      reason: `state "${prev}" is terminal — cannot transition to "${next}"`,
    };
  }
  if (!allowed.includes(next)) {
    return {
      ok: false,
      prev,
      next,
      reason: `illegal transition "${prev}" → "${next}" (allowed: ${
        allowed.length > 0 ? allowed.map((s) => `"${s}"`).join(", ") : "none"
      })`,
    };
  }
  return { ok: true, prev, next };
}

/**
 * Build the `ctx.state` key under which a state machine stores its current
 * label. Exposed so user code or tests can read the same bag the invariant
 * writes to.
 */
export function stateMachineKey(name: string): string {
  return `sm:${name}`;
}

/**
 * Read the current state label for a state machine from a state bag, or
 * `initial` when nothing has been recorded yet.
 */
export function stateMachineCurrent<S extends string>(
  name: string,
  initial: S,
  state: Map<string, unknown>,
): S {
  const key = stateMachineKey(name);
  const raw = state.get(key);
  return typeof raw === "string" ? (raw as S) : initial;
}

/**
 * Compile a `StateMachineInvariantOptions` down to an ordinary `Invariant`.
 * The resulting invariant is a regular value — the user can put it in their
 * `invariants` array alongside any other Invariant.
 */
export function stateMachineInvariant<S extends string>(
  opts: StateMachineInvariantOptions<S>,
): Invariant {
  const { name, initial, transitions, derive } = opts;
  const key = stateMachineKey(name);
  const inv: Invariant = {
    name,
    when: opts.when ?? "afterActions",
    async check(ctx: InvariantContext) {
      const prev = stateMachineCurrent(name, initial, ctx.state);
      const next = await derive({ page: ctx.page, url: ctx.url, prev, errors: ctx.errors });
      const verdict = validateTransition(prev, next, transitions);
      if (!verdict.ok) {
        return verdict.reason!;
      }
      if (next !== prev) {
        ctx.state.set(key, next);
      } else if (!ctx.state.has(key)) {
        // First derive of the run — record the label even if it equals
        // `initial` so subsequent calls can detect the next transition.
        ctx.state.set(key, next);
      }
      return undefined;
    },
  };
  if (opts.urlPattern !== undefined) {
    inv.urlPattern = opts.urlPattern;
  }
  return inv;
}
