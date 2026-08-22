/**
 * "Did my fault actually fire?" — in one shape, across all four layers.
 *
 * This is the check that everything else in the harness is downstream of: a
 * fault whose request the app never issues looks exactly like a pass, and so
 * does a typo'd `urlPattern`. It was also needlessly hard to write, because
 * each layer reports its own shape. The network layer calls the count
 * `injected` and labels the row `rule`; the runtime and iframe layers call it
 * `fired`; the lifecycle layer calls it `fired` and labels the row `name`. So
 * `stats.injected` on a runtime fault is `undefined` — and `undefined > 0` is
 * false, which turns the most important assertion in the suite into a silent
 * no-op. Somebody hit exactly that.
 *
 * These functions normalise the four into one vocabulary. They are pure
 * report readers: nothing here touches a browser.
 */
import type { CrawlReport } from "./types.js";

/** Which layer produced a firing row. */
export type FaultLayer = "network" | "runtime" | "lifecycle" | "iframe";

export interface Firing {
  /** The rule's `name`, or the label the layer derived for it. */
  name: string;
  layer: FaultLayer;
  /** Requests, pages or iframes whose pattern matched. */
  matched: number;
  /**
   * Times the fault actually took effect. The network layer's `injected` and
   * every other layer's `fired` are the same question, so they are the same
   * field here.
   */
  fired: number;
  /**
   * False when the source row carried no usable counters — a report from an
   * older version, a hand-built one, a run that died before the stats arrays
   * were written. `matched` and `fired` read 0 in that case, which is the only
   * safe default, and this flag is how a caller tells "nothing happened" from
   * "nothing was measured". They are very different findings.
   */
  counted: boolean;
  /**
   * Times the fault decided to fire and something else answered first.
   * Network and runtime layers only; 0 elsewhere.
   */
  suppressed: number;
  /** Times the fault threw while firing. Lifecycle layer only; 0 elsewhere. */
  errored: number;
}

/**
 * Every fault the run configured, with what it did.
 *
 * Rows are returned for faults that never fired too — that is the point. A
 * missing row means the layer reported no stats at all, which happens when the
 * crawl died before the routes went on.
 */
export function faultFirings(report: CrawlReport): Firing[] {
  // One builder, four layers. The counters are coerced rather than trusted:
  // a row missing `matched` produced `matched: undefined`, and
  // `unfiredFaults` then reported `matched undefinedx and never fired` — a
  // diagnosis with `undefined` in it, from the function whose whole job is to
  // give a usable one, asserting a firing policy that had not been consulted.
  const row = (
    name: unknown,
    layer: FaultLayer,
    matched: unknown,
    fired: unknown,
    suppressed: unknown,
    errored: unknown,
  ): Firing => ({
    name: typeof name === "string" && name.length > 0 ? name : "(unnamed)",
    layer,
    matched: typeof matched === "number" && Number.isFinite(matched) ? matched : 0,
    fired: typeof fired === "number" && Number.isFinite(fired) ? fired : 0,
    suppressed: typeof suppressed === "number" && Number.isFinite(suppressed) ? suppressed : 0,
    errored: typeof errored === "number" && Number.isFinite(errored) ? errored : 0,
    counted: typeof matched === "number" && Number.isFinite(matched),
  });

  const out: Firing[] = [];
  for (const s of report.faultInjections ?? []) {
    out.push(row(s.rule, "network", s.matched, s.injected, s.suppressed, 0));
  }
  for (const s of report.runtimeFaults ?? []) {
    out.push(row(s.rule, "runtime", s.matched, s.fired, s.suppressed, 0));
  }
  for (const s of report.lifecycleFaults ?? []) {
    out.push(row(s.name, "lifecycle", s.matched, s.fired, 0, s.errored));
  }
  for (const s of report.iframeFaults ?? []) {
    out.push(row(s.rule, "iframe", s.matched, s.fired, 0, 0));
  }
  return out;
}

/**
 * The faults that never took effect, with the reason visible in the message.
 *
 * Pass this straight into whatever your test framework uses for a failure —
 * an empty array is the assertion you want, and the strings say which of the
 * two very different problems you have:
 *
 * - `matched: 0` — nothing ever matched the pattern. Usually the pattern is
 *   wrong, or the app does not make the request you think it does.
 * - matched but never fired — the pattern is right and the firing policy said
 *   no. A schedule shorter than the number of calls, a `probability` that did
 *   not roll, or (with `suppressed` non-zero) a rule ahead of this one
 *   answering first.
 *
 * `only` restricts the check to the names you care about, for a run that
 * deliberately configures a fault it does not expect to fire.
 */
export function unfiredFaults(report: CrawlReport, only?: readonly string[]): string[] {
  const wanted = only ? new Set(only) : null;
  const problems: string[] = [];
  for (const f of faultFirings(report)) {
    if (wanted && !wanted.has(f.name)) continue;
    if (f.fired > 0) continue;
    if (!f.counted) {
      // A third case, and it used to be reported as the second: the row
      // carries no usable counters, so the firing policy was never consulted.
      // Unmeasured is not the same as didn't-fire.
      problems.push(
        `${f.layer} fault "${f.name}" reported no usable counters — nothing measured whether ` +
          `it fired, so this run decides nothing about it`,
      );
      continue;
    }
    if (f.matched === 0) {
      problems.push(
        `${f.layer} fault "${f.name}" never matched anything — the pattern did not see the ` +
          `request (or page, or iframe) you expected`,
      );
    } else {
      const because =
        f.suppressed > 0
          ? `; ${f.suppressed} decision(s) lost to a rule ahead of it`
          : "";
      problems.push(
        `${f.layer} fault "${f.name}" matched ${f.matched}x and never fired — the firing ` +
          `policy said no${because}`,
      );
    }
  }
  if (wanted) {
    const seen = new Set(faultFirings(report).map((f) => f.name));
    for (const name of wanted) {
      if (!seen.has(name)) {
        problems.push(
          `no layer reported stats for a fault named "${name}" — it was not configured under ` +
            `that name, or the run ended before the faults were installed`,
        );
      }
    }
  }
  return problems;
}
