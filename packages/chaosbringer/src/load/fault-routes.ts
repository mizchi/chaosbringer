/**
 * Network fault wiring for `scenarioLoad`. Duplicates the small subset
 * of `crawler.ts`'s fault-route handling instead of refactoring the
 * crawler — the load runner has different lifetime semantics (per-context
 * routes, no SPA recovery dump, no traceparent injection) and forcing a
 * shared abstraction here would over-couple two evolving callers.
 */
import type { BrowserContext, Route, Request } from "playwright";
import { validateFaultSchedule } from "../schedule.js";
import { pickFaultRule } from "../fault-router.js";
import type { Fault, FaultRule, FaultInjectionStats, UrlMatcher } from "../types.js";

interface CompiledRule {
  rule: FaultRule;
  pattern: RegExp;
  methods?: string[];
  matched: number;
  injected: number;
  /**
   * Times this rule's schedule said "inject" and an earlier rule had already
   * claimed the request. Same meaning as on the crawler's network layer, and
   * present for the same reason: `matched=3 injected=0` is otherwise
   * indistinguishable from an all-`pass` schedule.
   */
  suppressed: number;
  /**
   * Wall-clock timestamps (ms) at which this rule actually injected
   * a fault. Captured so the runner can correlate fault firings with
   * throughput / error dips in the timeline. Bounded only by `injected`
   * — at load-run scale (~thousands per rule max) the memory is trivial.
   */
  firings: number[];
}

/**
 * Upper bound for a `hang` fault with no explicit `releaseAfterMs` in a load
 * run. Long enough that the app has clearly missed any sane timeout, short
 * enough that a worker isn't wedged for the rest of the run.
 */
const LOAD_HANG_RELEASE_MS = 30_000;

function toRegExp(matcher: UrlMatcher | undefined): RegExp | null {
  if (matcher === undefined) return /.*/;
  if (matcher instanceof RegExp) return matcher;
  if (typeof matcher === "string") {
    try {
      return new RegExp(matcher);
    } catch {
      return null;
    }
  }
  return null;
}

export function compileLoadFaultRules(rules: ReadonlyArray<FaultRule | Fault> | undefined): CompiledRule[] {
  if (!rules || rules.length === 0) return [];
  const out: CompiledRule[] = [];
  for (const r of rules) {
    // FaultRule has `urlPattern` + `fault`; bare Fault would be a programmer
    // error here, so just skip with a 0-row entry rather than crash.
    if (!("fault" in r)) continue;
    // The other four layers validate here, and this one did not: a rule
    // setting both `probability` and `schedule` threw everywhere except on
    // the load path, where the schedule silently won, and a malformed
    // `decisions` entry silently never fired. A firing policy that is wrong
    // in a way nothing reports is the worst kind of fault config.
    validateFaultSchedule(`load fault rule "${r.name ?? String(r.urlPattern)}"`, r);
    const pattern = toRegExp(r.urlPattern);
    if (!pattern) continue;
    out.push({
      rule: r,
      pattern,
      methods: r.methods?.map((m) => m.toUpperCase()),
      matched: 0,
      injected: 0,
      suppressed: 0,
      firings: [],
    });
  }
  return out;
}

async function applyFault(route: Route, fault: Fault): Promise<void> {
  switch (fault.kind) {
    case "abort":
      await route.abort(fault.errorCode ?? "failed");
      return;
    case "status": {
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
      // Load runs have no per-page teardown hook to drain parked routes, so
      // a hang always gets a bound here: `releaseAfterMs` when given, else
      // LOAD_HANG_RELEASE_MS. Until then the request stays in flight, which
      // is the fault.
      const ms = fault.releaseAfterMs ?? LOAD_HANG_RELEASE_MS;
      // `unref`: the default bound is 30s, and without this a load run with
      // an unbounded `hang` holds the process open for 30s after its report
      // is printed.
      const timer = setTimeout(() => {
        void route.abort("timedout").catch(() => {
          /* context already gone */
        });
      }, ms);
      timer.unref?.();
      return;
    }
  }
}

/**
 * Install a single `**` route on the context that runs the compiled fault
 * rules. A rule with a `schedule` is decided by occurrence; otherwise the
 * probability is rolled per match. Stats are mutated on the compiled rule
 * objects — drain via `faultStatsFrom` at run end.
 *
 * Two passes over one list, using the crawler's own `pickFaultRule` rather
 * than a second copy of the decision: a *scheduled* rule consumes its
 * occurrence whenever its pattern matches, even if an earlier rule already
 * claimed the request, so two rules watching one URL agree about what
 * "occurrence 3" means. Rules on the probability path stay lazy. This used to
 * be single-pass — `return` on the first injection — which made `decisions`
 * mean something different here than on the crawler's layers, silently.
 */
export async function installFaultRoutes(
  context: BrowserContext,
  compiled: ReadonlyArray<CompiledRule>,
): Promise<void> {
  if (compiled.length === 0) return;
  await context.route("**/*", async (route: Route, request: Request) => {
    const url = request.url();
    const method = request.method().toUpperCase();
    // Load runs are unseeded by design (workers run concurrently), so the
    // probability path draws from `Math.random`; a `schedule` ignores the RNG
    // entirely and reads its decision table by occurrence.
    const winner = pickFaultRule(compiled, url, method, { next: Math.random });
    if (!winner) {
      await route.fallback();
      return;
    }
    winner.firings.push(Date.now());
    await applyFault(route, winner.rule.fault);
  });
}

export function faultStatsFrom(
  compiled: ReadonlyArray<CompiledRule>,
): FaultInjectionStats[] {
  return compiled.map((c, i) => ({
    rule: c.rule.name ?? `fault-${i}`,
    matched: c.matched,
    injected: c.injected,
    ...(c.suppressed > 0 ? { suppressed: c.suppressed } : {}),
  }));
}

/**
 * Return (ruleName → wall-clock firing timestamps) for every compiled
 * rule, including rules that never fired (empty array). Used by the
 * report builder to bucket firings into the timeline.
 */
export function faultFiringsFrom(
  compiled: ReadonlyArray<CompiledRule>,
): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  compiled.forEach((c, i) => {
    const name = c.rule.name ?? `fault-${i}`;
    out[name] = [...c.firings];
  });
  return out;
}
