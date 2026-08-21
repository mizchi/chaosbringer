/**
 * The network fault layer, on its own.
 *
 * This is the machinery `ChaosCrawler` uses to decide which `FaultRule`
 * answers a request and to realise it on the route — extracted so it can be
 * applied to a `Page` the caller drives themselves. Three independent readers
 * of this library reached for exactly that and could not find it: every fault
 * layer was reachable only through `chaos()`, `ChaosCrawler` or `runPlan`,
 * which all run a crawl. A targeted regression test wants one page, one
 * scripted click, and a rule that fires on a known request.
 *
 * It lives in one module rather than two copies because "a rule encoded more
 * than once" is the defect this codebase keeps producing: the copy the tests
 * were written against gets fixed, and the other one stays wrong.
 */

import type { Page, Route } from "playwright";
import { decideFault, validateFaultSchedule } from "./schedule.js";
import type { Fault, FaultInjectionStats, FaultRule, UrlMatcher } from "./types.js";
import { compileUrlMatcher } from "./url-matcher.js";
import { createRng, randomSeed, type Rng } from "./random.js";

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

export function compileFaultRules(rules: FaultRule[] | undefined): CompiledFaultRule[] {
  if (!rules || rules.length === 0) return [];
  const compiled: CompiledFaultRule[] = [];
  for (const rule of rules) {
    const pattern = toRegExp(rule.urlPattern);
    if (!pattern) {
      // Skip invalid regex silently; validateOptions will have already raised.
      continue;
    }
    compiled.push({
      rule,
      pattern,
      methods: rule.methods?.map((m) => m.toUpperCase()),
      matched: 0,
      injected: 0,
      suppressed: 0,
    });
  }
  return compiled;
}

/**
 * Realise one `Fault` on a matched route.
 *
 * `hold` is the crawler's held-route registry, used only by an *unbounded*
 * `hang`: a hung request must stay in flight, so the handler returns without
 * responding and the registry aborts it when the run is done with the page.
 * Without that registry a hung route would keep the browser context from
 * closing cleanly. A `hang` with `releaseAfterMs` never enters the registry —
 * it aborts itself on its own timer — which is also why `report.heldRequests`
 * counts only the unbounded kind.
 */
export async function applyFault(
  route: Route,
  fault: Fault,
  hold?: (route: Route) => void,
): Promise<void> {
  switch (fault.kind) {
    case "abort":
      await route.abort(fault.errorCode ?? "failed");
      return;
    case "status": {
      // Chromium emits a spurious ERR_ABORTED alongside the response when the
      // body is empty, so synthesise a minimal JSON body by default. Callers
      // can still opt into an empty body by passing `body: ""` explicitly.
      const body =
        fault.body !== undefined ? fault.body : JSON.stringify({ error: fault.status });
      await route.fulfill({
        status: fault.status,
        body,
        contentType: fault.contentType ?? "application/json",
      });
      return;
    }
    case "delay":
      await new Promise((r) => setTimeout(r, fault.ms));
      await route.fallback();
      return;
    case "hang": {
      // Deliberately do not respond and do not await: returning leaves the
      // request in flight, which is the whole point of the fault.
      if (fault.releaseAfterMs !== undefined) {
        const ms = fault.releaseAfterMs;
        // `unref` so the timer cannot outlive the work. A library consumer —
        // vitest, `playwright test` — has a worker process that would
        // otherwise linger for the whole release window after the run is
        // finished; a 15s hang held one for 15s past the last assertion. The
        // CLI never noticed because it calls `process.exit`.
        const timer = setTimeout(() => {
          void route.abort("timedout").catch(() => {
            /* page may already be gone */
          });
        }, ms);
        timer.unref?.();
        return;
      }
      hold?.(route);
      return;
    }
  }
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
export function pickFaultRule(
  rules: ReadonlyArray<CompiledFaultRule>,
  url: string,
  method: string,
  rng: Rng,
): CompiledFaultRule | null {
  let winner: CompiledFaultRule | null = null;
  for (const compiled of rules) {
    if (!compiled.pattern.test(url)) continue;
    if (compiled.methods && !compiled.methods.includes(method)) continue;

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

/** A page with fault rules installed. Returned by `applyFaultRules`. */
export interface FaultSession {
  /**
   * Per-rule counters, live. `matched: 0` on a rule you expected to fire is
   * the first thing to check when a fault test passes for no reason — it
   * usually means the `urlPattern` does not match what the app requests.
   */
  stats(): FaultInjectionStats[];
  /**
   * Requests currently parked by an unbounded `hang` — held open, never
   * answered. Non-zero means the app is waiting on something that will not
   * arrive, which is usually the point.
   */
  heldRequests(): number;
  /**
   * Abort every parked request. Call it when you are done observing the
   * spinner: the app's promise rejects, and its `catch` runs. Safe to call
   * repeatedly, and safe after the page has closed.
   */
  release(): Promise<void>;
  /**
   * Release, then remove the route. The page goes back to talking to the real
   * origin. Also unwinds the HTTP-cache side effect of having a route
   * installed, which is worth knowing about: Playwright disables the page's
   * cache while any route is active, so a cacheable asset is re-fetched on
   * every navigation until you dispose.
   */
  dispose(): Promise<void>;
}

/**
 * Install `rules` on a page you own, and hand back the counters.
 *
 * The fault decision is identical to the one `ChaosCrawler` makes — same
 * two-pass loop, same occurrence numbering, same `schedule` / `probability`
 * semantics — because it is the same function. What is absent is everything
 * else a crawl does: no navigation, no action driver, no invariants, no
 * report. You drive the page.
 *
 * ```ts
 * const faults = await applyFaultRules(page, [
 *   faults.status({ urlPattern: /\/api\/save$/, methods: ["POST"], status: 500 }),
 * ]);
 * await page.getByRole("button", { name: "Save" }).click();
 * expect(faults.stats()[0]?.injected).toBe(1); // it really fired
 * await faults.dispose();
 * ```
 *
 * `seed` only matters for rules using `probability`; a rule with a `schedule`
 * consumes no randomness, which is what makes a scheduled rule the right
 * choice for a regression test.
 */
export async function applyFaultRules(
  page: Page,
  rules: ReadonlyArray<FaultRule>,
  opts: { seed?: number } = {},
): Promise<FaultSession> {
  // `ChaosCrawler` validates in `validateOptions`; this entry point has no
  // options object to validate, so it happens here — a rule setting both
  // `probability` and `schedule` should fail at the call site, not silently
  // pick one.
  for (const rule of rules) {
    validateFaultSchedule(`fault rule "${rule.name ?? String(rule.urlPattern)}"`, rule);
  }
  const compiled = compileFaultRules([...rules]);
  const rng = createRng(opts.seed ?? randomSeed());
  let held: Route[] = [];
  let heldCount = 0;

  const drain = async (): Promise<void> => {
    if (held.length === 0) return;
    const parked = held;
    held = [];
    await Promise.all(
      parked.map((r) =>
        r.abort("timedout").catch(() => {
          /* page already gone — the request died with it */
        }),
      ),
    );
  };

  const handler = async (route: Route): Promise<void> => {
    const request = route.request();
    const winner = pickFaultRule(compiled, request.url(), request.method().toUpperCase(), rng);
    if (!winner) {
      // `fallback()` rather than `continue()` so a context-level route the
      // caller installed (routeFromHAR, say) still gets its turn.
      await route.fallback();
      return;
    }
    await applyFault(route, winner.rule.fault, (r) => {
      held.push(r);
      heldCount++;
    });
  };

  await page.route("**/*", handler);

  return {
    stats: () => faultStatsOf(compiled),
    heldRequests: () => heldCount,
    release: drain,
    dispose: async () => {
      await drain();
      await page.unroute("**/*", handler).catch(() => {
        /* page already closed — the route went with it */
      });
    },
  };
}
