/**
 * The network rule decision, with no transport attached.
 *
 * `@mizchi/playwright-faults/network` is the part of a `FaultRule` run that
 * does not care how a request travels: compile the rules once, decide which
 * one answers a request (advancing the counters that have to advance), and
 * report the counters. Realising the fault — `route.abort`, `route.fulfill`,
 * a `Response` built by some other transport — stays with the adapter.
 *
 * It lives here, behind its own entry, because two adapters need the same
 * decision: chaosbringer's Playwright route handler and transports that are
 * not Playwright at all (a `fetch(request)` egress hook, say). A second copy
 * is the defect this codebase keeps producing — the copy the tests were
 * written against gets fixed, the other one stays wrong — and a seeded run
 * only means one thing if every adapter draws the same numbers in the same
 * order. The entry imports nothing from Playwright or `node:*`, so a Worker
 * bundle can load it.
 */

import { decideFault } from "./schedule.js";
import type { FaultInjectionStats, FaultRule, Rng, UrlMatcher } from "./types.js";
import { compileUrlMatcher } from "./url-matcher.js";

// Re-exported so an adapter takes all of its runtime code from this entry.
export { decideFault, validateFaultSchedule } from "./schedule.js";
export { createRng, type SeededRng } from "./random.js";

/** `route.abort()` code for an `abort` fault that names none. */
export const DEFAULT_ABORT_ERROR_CODE = "failed";

/** Content type of a `status` fault's response when the rule names none. */
export const DEFAULT_STATUS_CONTENT_TYPE = "application/json";

/**
 * Body of a `status` fault's response: the rule's own body when it has one —
 * including `""`, which is a deliberate empty body — else `{"error":<status>}`.
 *
 * The default decides which app bug a 5xx finds. A client that skips `res.ok`
 * and calls `res.json()` renders junk out of `{"error":500}` and reports
 * success; the same client on an empty body has `res.json()` reject and takes
 * its error path. Every adapter has to make the same choice, or one rule
 * tests a different defect depending on where it runs.
 */
export function faultStatusBody(fault: { status: number; body?: string }): string {
  return fault.body !== undefined ? fault.body : JSON.stringify({ error: fault.status });
}

/**
 * Coerce a UrlMatcher to RegExp. Returns null if the string is not a valid
 * regex. `compileUrlMatcher` drops stateful flags (`g`, `y`): one pattern is
 * tested against every request that goes past, and a `lastIndex` would make
 * the rule fire on alternating requests.
 */
export function toRegExp(m: UrlMatcher): RegExp | null {
  try {
    return compileUrlMatcher(m);
  } catch {
    return null;
  }
}

/** A `FaultRule` with its pattern compiled once and its counters. */
export type CompiledFaultRule = {
  rule: FaultRule;
  pattern: RegExp;
  methods?: string[];
  resourceTypes?: string[];
  matched: number;
  injected: number;
  /**
   * Times this rule's schedule said "inject" and an earlier rule had already
   * claimed the request. The decision was consumed — the occurrence advanced —
   * and could not be acted on. Without this counter such a rule reports
   * `matched=3 injected=0`, byte-identical to an all-`pass` schedule, and the
   * one thing a reader needs (a planned fault that did not happen, and why) is
   * the thing the report drops.
   */
  suppressed: number;
};

/**
 * Compile `rules` once, with zeroed counters. Throws on a `urlPattern` that is
 * not a valid regular expression, naming the rule.
 *
 * `prefix` is the package the caller belongs to, as in
 * `validateFaultSchedule`: a user who installed one package should be handed
 * that package's name in the error, not the name of a dependency.
 */
export function compileFaultRules(
  rules: FaultRule[] | undefined,
  prefix = "chaosbringer",
): CompiledFaultRule[] {
  if (!rules || rules.length === 0) return [];
  const compiled: CompiledFaultRule[] = [];
  for (const [i, rule] of rules.entries()) {
    const pattern = toRegExp(rule.urlPattern);
    if (!pattern) {
      // This used to `continue`, on the premise that "validateOptions will have
      // already raised". True for `ChaosCrawler`, and false for `applyFaults` /
      // `applyFaultRules`, which have no options object and validate schedules
      // and layer confusion here but never the pattern. Measured on
      // `applyFaultRules(page, [{ urlPattern: "/api/(cart", … }])`: no error,
      // the page saw 200, `stats()` was `[]` and `firings()` was `{}` — the
      // rule was not even listed as having matched nothing. That presents as
      // "my fault never fired", which this codebase repeatedly calls the
      // hardest thing in it to debug.
      //
      // Thrown here rather than fixed in the second caller, so one rule lives
      // in one place. `validateOptions` still runs first on the crawler path
      // and still produces its more specific message, so nothing changes
      // there.
      const label = rule.name ? `"${rule.name}"` : `#${i}`;
      throw new Error(
        `${prefix}: faultInjection rule ${label} has an invalid urlPattern ` +
          `(${JSON.stringify(String(rule.urlPattern))}) — it is not a valid regular expression, ` +
          `so the rule cannot be installed. Skipping it silently would present as "my fault ` +
          `never fired" with an empty stats table.`,
      );
    }
    compiled.push({
      rule,
      pattern,
      methods: rule.methods?.map((m) => m.toUpperCase()),
      ...(rule.resourceTypes ? { resourceTypes: rule.resourceTypes.map((t) => t.toLowerCase()) } : {}),
      matched: 0,
      injected: 0,
      suppressed: 0,
    });
  }
  return compiled;
}

/**
 * Decide which rule answers this request, advancing every counter that has to
 * advance on the way.
 *
 * Two passes over one list. A *scheduled* rule always consumes its occurrence
 * when its pattern matches, even if an earlier rule already claimed the
 * request: two rules watching the same URL must agree on what "occurrence 3"
 * means, or a plan cannot hand occurrence 0 to one outcome and occurrence 1 to
 * another. Rules on the probability path stay lazy — never consulted once a
 * winner exists — so adding a rule behind one that always fires does not shift
 * an existing seed's draw sequence.
 *
 * Mutates `matched`, `suppressed` and (for the winner) `injected`, and returns
 * the winner or null.
 */
export function pickFaultRule<T extends CompiledFaultRule>(
  rules: ReadonlyArray<T>,
  url: string,
  method: string,
  // Only `next` is used. Typed as the minimum rather than a seeded generator
  // so the load path — which is unseeded by design, because its workers run
  // concurrently — can pass `{ next: Math.random }` and still share this
  // function instead of keeping a second copy of the decision.
  rng: Pick<Rng, "next">,
  // Playwright's `request.resourceType()`; a rule with `resourceTypes` does
  // not match a request whose type is unknown.
  resourceType?: string,
): T | null {
  let winner: T | null = null;
  for (const compiled of rules) {
    if (!compiled.pattern.test(url)) continue;
    if (compiled.methods && !compiled.methods.includes(method)) continue;
    if (compiled.resourceTypes && (resourceType === undefined || !compiled.resourceTypes.includes(resourceType.toLowerCase()))) continue;

    if (compiled.rule.schedule) {
      const occurrence = compiled.matched;
      compiled.matched++;
      if (decideFault(compiled.rule, occurrence, rng) === "inject") {
        // The decision is consumed either way — that is what keeps two rules
        // on one URL agreeing about occurrence numbers — but only one rule can
        // answer the request. Record the loss instead of dropping it:
        // `injected` alone cannot tell "the schedule said pass" from "the
        // schedule said inject and somebody else got there first".
        if (winner) compiled.suppressed++;
        else winner = compiled;
      }
      continue;
    }
    if (winner) continue;
    const occurrence = compiled.matched;
    compiled.matched++;
    if (decideFault(compiled.rule, occurrence, rng) === "inject") winner = compiled;
  }
  if (winner) winner.injected++;
  return winner;
}

/** Per-rule stats in the same shape `CrawlReport.faultInjections` uses. */
export function faultStatsOf(
  rules: ReadonlyArray<CompiledFaultRule>,
): FaultInjectionStats[] {
  return rules.map((c) => ({
    rule: c.rule.name ?? c.pattern.toString(),
    matched: c.matched,
    injected: c.injected,
    ...(c.suppressed > 0 ? { suppressed: c.suppressed } : {}),
  }));
}
