/**
 * Network fault wiring for `scenarioLoad`. Duplicates the small subset
 * of `crawler.ts`'s fault-route handling instead of refactoring the
 * crawler — the load runner has different lifetime semantics (per-context
 * routes, no SPA recovery dump, no traceparent injection) and forcing a
 * shared abstraction here would over-couple two evolving callers.
 */
import type { BrowserContext, Route, Request } from "playwright";
import type { Fault, FaultRule, FaultInjectionStats, UrlMatcher } from "../types.js";

interface CompiledRule {
  rule: FaultRule;
  pattern: RegExp;
  methods?: string[];
  matched: number;
  injected: number;
  /**
   * Wall-clock timestamps (ms) at which this rule actually injected
   * a fault. Captured so the runner can correlate fault firings with
   * throughput / error dips in the timeline. Bounded only by `injected`
   * — at load-run scale (~thousands per rule max) the memory is trivial.
   */
  firings: number[];
}

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
    const pattern = toRegExp(r.urlPattern);
    if (!pattern) continue;
    out.push({
      rule: r,
      pattern,
      methods: r.methods?.map((m) => m.toUpperCase()),
      matched: 0,
      injected: 0,
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
  }
}

/**
 * Install a single `**` route on the context that runs the compiled
 * fault rules. Rolls probability for each match. Stats are mutated on
 * the compiled rule objects — drain via `faultStatsFrom` at run end.
 */
export async function installFaultRoutes(
  context: BrowserContext,
  compiled: ReadonlyArray<CompiledRule>,
): Promise<void> {
  if (compiled.length === 0) return;
  await context.route("**/*", async (route: Route, request: Request) => {
    const url = request.url();
    const method = request.method().toUpperCase();
    for (const c of compiled) {
      if (!c.pattern.test(url)) continue;
      if (c.methods && !c.methods.includes(method)) continue;
      c.matched += 1;
      const probability = c.rule.probability ?? 1;
      if (Math.random() >= probability) continue;
      c.injected += 1;
      c.firings.push(Date.now());
      await applyFault(route, c.rule.fault);
      return;
    }
    await route.fallback();
  });
}

export function faultStatsFrom(
  compiled: ReadonlyArray<CompiledRule>,
): FaultInjectionStats[] {
  return compiled.map((c, i) => ({
    rule: c.rule.name ?? `fault-${i}`,
    matched: c.matched,
    injected: c.injected,
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
