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
 * `applyFaults` covers the network *and* runtime layers, because which layer
 * implements a fault is the library's business, not the caller's — and the
 * split bit somebody immediately: a double-write regression needs
 * `faults.rejectBody()` (runtime, so the server really commits) applied to a
 * page they drive (which only existed for the network layer), and the two
 * recommendations did not compose.
 *
 * It lives in one module rather than two copies because "a rule encoded more
 * than once" is the defect this codebase keeps producing: the copy the tests
 * were written against gets fixed, and the other one stays wrong.
 */

import type { Page, Route } from "playwright";
import { decideFault, validateFaultSchedule } from "./schedule.js";
import type {
  Fault,
  FaultInjectionStats,
  FaultRule,
  RuntimeFault,
  RuntimeFaultStats,
  UrlMatcher,
} from "./types.js";
import { compileUrlMatcher } from "./url-matcher.js";
import { createRng, randomSeed, type Rng } from "./random.js";
import {
  buildRuntimeFaultsScript,
  compileRuntimeFaults,
  type CompiledRuntimeFault,
} from "./runtime-faults.js";
import { faultFirings, type Firing } from "./firings.js";

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
        `chaosbringer: faultInjection rule ${label} has an invalid urlPattern ` +
          `(${JSON.stringify(String(rule.urlPattern))}) — it is not a valid regular expression, ` +
          `so the rule cannot be installed. Skipping it silently would present as "my fault ` +
          `never fired" with an empty stats table.`,
      );
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
      // The default body is `{"error":<status>}`, not empty.
      //
      // The reason recorded here used to be "Chromium emits a spurious
      // ERR_ABORTED alongside an empty intercepted body". That does not
      // reproduce on Chromium 147: an empty-bodied intercepted 500 produces no
      // `requestfailed`, no ERR_ABORTED on any channel, and the same single
      // console line as a JSON-bodied one. Either it was fixed upstream or it
      // was always narrower than the comment claimed.
      //
      // The default stays, for a reason that is easy to verify and matters
      // more: it decides which app bug a 500 finds. A client that skips
      // `res.ok` and calls `res.json()` renders junk out of `{"error":500}` and
      // reports success; the same client on an empty body has `res.json()`
      // *reject* and takes its error path (or leaks an unhandled rejection).
      // Those are two different defects behind one status code, so the choice
      // belongs to the caller — `body: ""` for the second — and flipping the
      // default now would silently re-point every existing suite at the other
      // bug.
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
    default: {
      // Falling off this switch used to be obviously a bug: nothing responded,
      // so the request hung and somebody noticed. Since `hang` exists, a
      // typo'd `kind` produces exactly the "deliberately parked" behaviour —
      // but with no entry in the held-route registry, so nothing drains it and
      // nothing counts it. Indistinguishable from intent, which is the worst
      // way for a config error to present.
      const unknown: never = fault;
      throw new Error(
        `chaosbringer: unknown fault kind ${JSON.stringify((unknown as { kind?: unknown }).kind)} — ` +
          `expected one of abort, status, delay, hang`,
      );
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
export function pickFaultRule<T extends CompiledFaultRule>(
  rules: ReadonlyArray<T>,
  url: string,
  method: string,
  // Only `next` is used. Typed as the minimum rather than the whole `Rng` so
  // the load path — which is unseeded by design, because its workers run
  // concurrently — can pass `{ next: Math.random }` and still share this
  // function instead of keeping a second copy of the decision.
  rng: Pick<Rng, "next">,
): T | null {
  let winner: T | null = null;
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

/** A page with faults installed. Returned by `applyFaults` / `applyFaultRules`. */
export interface FaultSession {
  /**
   * Per-rule counters for the network layer, live. `matched: 0` on a rule you
   * expected to fire is the first thing to check when a fault test passes for
   * no reason — it usually means the `urlPattern` does not match what the app
   * requests.
   */
  stats(): FaultInjectionStats[];
  /**
   * Per-fault counters for the runtime layer, read out of the page. Async
   * because the numbers live in the page, not here.
   */
  runtimeStats(): Promise<RuntimeFaultStats[]>;
  /**
   * Both layers in one vocabulary — the network layer's `injected` and the
   * runtime layer's `fired` are the same question, so they are one field.
   * This is the reading to assert on; `stats().injected` on a fault that
   * turned out to be a runtime fault is `undefined`, and `undefined > 0` is a
   * silent no-op.
   */
  firings(): Promise<Firing[]>;
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
 *   faults.status(500, { urlPattern: /\/api\/save$/, methods: ["POST"] }),
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
export async function applyFaults(
  page: Page,
  spec: {
    /** Network-layer rules: an HTTP response the app never asked for. */
    network?: ReadonlyArray<FaultRule>;
    /**
     * Runtime-layer faults: the `fetch()` call itself failing, a body that will
     * not parse, a promise that never settles. These are installed as an init
     * script, so they take effect **on the next navigation** — apply first,
     * then `page.goto`. A fault applied to an already-loaded page does nothing,
     * silently, which is the failure mode this library exists to remove.
     */
    runtime?: ReadonlyArray<RuntimeFault>;
    /** Only matters for `probability`; a `schedule` consumes no randomness. */
    seed?: number;
  },
): Promise<FaultSession> {
  const rules = spec.network ?? [];
  const runtime = spec.runtime ?? [];
  // `ChaosCrawler` validates in `validateOptions`; this entry point has no
  // options object to validate, so it happens here — a rule setting both
  // `probability` and `schedule` should fail at the call site, not silently
  // pick one.
  for (const [i, rule] of rules.entries()) {
    // A runtime fault handed to `network:` used to reach the route handler and
    // die there with "Cannot read properties of undefined (reading 'kind')",
    // which names nothing a caller can act on. It is an easy mistake — the
    // library's own recipe for a retry-double-write is `faults.rejectBody()`,
    // a runtime fault — so refuse it here and say where it goes.
    if (rule !== null && typeof rule === "object" && !("fault" in rule) && "action" in rule) {
      const named = (rule as { name?: string }).name ?? `#${i}`;
      throw new Error(
        `chaosbringer: fault ${named} passed to \`network:\` is a RuntimeFault (it has ` +
          `\`action\`, not \`fault\`) — pass it as \`applyFaults(page, { runtime: [...] })\`. ` +
          `Runtime faults patch \`fetch\` inside the page, so they install as an init script ` +
          `and take effect on the next navigation.`,
      );
    }
    validateFaultSchedule(`fault rule "${rule.name ?? String(rule.urlPattern)}"`, rule);
  }
  for (const [i, fault] of runtime.entries()) {
    if (fault !== null && typeof fault === "object" && "fault" in fault && !("action" in fault)) {
      const named = (fault as { name?: string }).name ?? `#${i}`;
      throw new Error(
        `chaosbringer: fault ${named} passed to \`runtime:\` is a network FaultRule (it has ` +
          `\`fault\`, not \`action\`) — pass it as \`applyFaults(page, { network: [...] })\`.`,
      );
    }
  }
  const compiled = compileFaultRules([...rules]);
  const seed = spec.seed ?? randomSeed();
  const rng = createRng(seed);
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

  if (rules.length > 0) await page.route("**/*", handler);

  let compiledRuntime: CompiledRuntimeFault[] = [];
  if (runtime.length > 0) {
    compiledRuntime = compileRuntimeFaults([...runtime]);
    await page.addInitScript(buildRuntimeFaultsScript([...runtime], seed));
  }

  /**
   * Read the in-page counters.
   *
   * Deliberately *not* `mergeRuntimeStats`, which accumulates into the
   * compiled objects — right for a crawl summing many pages, wrong here:
   * calling it twice against one page's counters doubles them, and the first
   * version of this function did exactly that (`stats()` then `firings()`
   * reported `matched: 2` for one request). This reads the page and maps,
   * so it is idempotent.
   *
   * A page with no counters at all reports zeros rather than throwing: a
   * runtime fault applied *after* the navigation that would have installed it
   * really did match nothing, and saying so is more useful than an error.
   */
  // The last counters read out of the page, kept so a read after teardown
  // reports what happened rather than zeros. Reading `firings()` after
  // `dispose()` — or after the context closed — used to return all zeros,
  // which is indistinguishable from "the fault never fired": a silent no-op in
  // the one call that exists to stop silent no-ops.
  let lastRuntime: RuntimeFaultStats[] | null = null;

  const readRuntime = async (): Promise<RuntimeFaultStats[]> => {
    if (compiledRuntime.length === 0) return [];
    const raw = (await page.evaluate("window.__chaosbringerRuntimeStats").catch(() => null)) as
      | Record<string, { matched: number; fired: number; suppressed?: number }>
      | null;
    // `undefined` as well as `null`: an un-navigated page has no such global,
    // and `page.evaluate` hands back `undefined` rather than throwing.
    if (raw == null) {
      // The page is gone, or was never navigated. If we read real counters
      // earlier, those are the answer; otherwise zeros are honest — a runtime
      // fault applied after the navigation that would have installed it really
      // did match nothing.
      if (lastRuntime !== null) return lastRuntime;
      return compiledRuntime.map((c) => ({ rule: c.name, matched: 0, fired: 0 }));
    }
    const out = compiledRuntime.map((c, i) => {
      const ps = raw[String(i)];
      return {
        rule: c.name,
        matched: ps?.matched ?? 0,
        fired: ps?.fired ?? 0,
        ...(ps?.suppressed ? { suppressed: ps.suppressed } : {}),
      };
    });
    lastRuntime = out;
    return out;
  };

  return {
    stats: () => faultStatsOf(compiled),
    runtimeStats: readRuntime,
    firings: async () =>
      faultFirings({
        faultInjections: faultStatsOf(compiled),
        runtimeFaults: await readRuntime(),
      } as never),
    heldRequests: () => heldCount,
    release: drain,
    dispose: async () => {
      // Snapshot before teardown, so a `firings()` afterwards reports the run
      // rather than zeros.
      await readRuntime().catch(() => {
        /* nothing to snapshot */
      });
      await drain();
      if (rules.length > 0) {
        await page.unroute("**/*", handler).catch(() => {
          /* page already closed — the route went with it */
        });
      }
      // An init script cannot be removed, so a runtime fault outlives
      // `dispose()` for the life of this page. Say so rather than pretend:
      // if you need a clean page afterwards, make a new one.
    },
  };
}

/**
 * Network-layer faults only. `applyFaults(page, { network: rules })` under a
 * shorter name, kept because most one-incident regression tests want exactly
 * this and nothing else.
 */
export async function applyFaultRules(
  page: Page,
  rules: ReadonlyArray<FaultRule>,
  opts: { seed?: number } = {},
): Promise<FaultSession> {
  return applyFaults(page, { network: rules, seed: opts.seed });
}
