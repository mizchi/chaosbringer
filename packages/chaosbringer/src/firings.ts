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

/**
 * The part of a report these readers look at. A whole `CrawlReport` is one;
 * so is a report built by hand from the stats getters — after `testPage()`,
 * which returns none, or off a `faults` session:
 * `{ faultInjections: crawler.getFaultStats(), pages: [result] }`. A field
 * left out reads as that layer reporting nothing.
 */
export type FaultStatsReport = Partial<
  Pick<CrawlReport, "faultInjections" | "runtimeFaults" | "lifecycleFaults" | "iframeFaults" | "pages">
>;

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
export function faultFirings(report: FaultStatsReport): Firing[] {
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

/** The pages a service worker controlled, by what the network faults could see there. */
export interface ServiceWorkerReach {
  /** `PageResult.serviceWorker`: `"unrouted"` when any page was, the worse case. */
  reach: "routed" | "unrouted";
  /** How many pages had that reach. */
  pages: number;
}

/**
 * Whether a service worker can explain a network rule that matched nothing,
 * from the pages' `serviceWorker`. One `"unrouted"` page outweighs any number
 * of `"routed"` ones: on it the rule saw none of the requests the worker took.
 */
function serviceWorkerReach(report: FaultStatsReport): ServiceWorkerReach | null {
  const pages = Array.isArray(report.pages) ? report.pages : [];
  const unrouted = pages.filter((p) => p?.serviceWorker === "unrouted").length;
  if (unrouted > 0) return { reach: "unrouted", pages: unrouted };
  const routed = pages.filter((p) => p?.serviceWorker === "routed").length;
  return routed > 0 ? { reach: "routed", pages: routed } : null;
}

/** The `matched: 0` diagnosis for a network rule on a run a service worker was part of. */
function unmatchedBehindServiceWorker(name: string, sw: ServiceWorkerReach): string {
  const runtime = "`runtimeFaults` patch `fetch` in the page, ahead of the worker, and fire either way";
  if (sw.reach === "unrouted") {
    return (
      `network fault "${name}" never matched anything, and a service worker controlled ${sw.pages} ` +
      `page(s) where no network fault sees the requests it takes (\`testPage()\` on a context the ` +
      `crawler does not route, or an attached browser) — so this says nothing about the pattern. ` +
      `${runtime}; or create the context with \`serviceWorkers: "block"\``
    );
  }
  return (
    `network fault "${name}" never matched anything — the pattern did not see the request you ` +
    `expected, or a service worker answered it from its own cache, which no network fault reaches ` +
    `(one controlled ${sw.pages} page(s)). ${runtime}`
  );
}

/**
 * The faults that never took effect, with the reason visible in the message.
 *
 * Pass this straight into whatever your test framework uses for a failure —
 * an empty array is the assertion you want, and the strings say which of the
 * two very different problems you have:
 *
 * - `matched: 0` — nothing ever matched the pattern. Usually the pattern is
 *   wrong, or the app does not make the request you think it does. On a page
 *   a service worker controlled (`PageResult.serviceWorker`), a network rule
 *   can also have missed a request the worker took, and the message says so
 *   instead of blaming the pattern. Pass `pages` with the stats to get that
 *   on a hand-built report: `{ faultInjections, pages: [result] }`.
 * - matched but never fired — the pattern is right and the firing policy said
 *   no. A schedule shorter than the number of calls, a `probability` that did
 *   not roll, or (with `suppressed` non-zero) a rule ahead of this one
 *   answering first.
 *
 * `only` restricts the check to the names you care about, for a run that
 * deliberately configures a fault it does not expect to fire.
 */
export function unfiredFaults(report: FaultStatsReport, only?: readonly string[]): string[] {
  const wanted = only ? new Set(only) : null;
  const problems: string[] = [];
  const sw = serviceWorkerReach(report);
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
    if (f.matched === 0 && f.layer === "network" && sw) {
      problems.push(unmatchedBehindServiceWorker(f.name, sw));
    } else if (f.matched === 0) {
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

/** One logger event for one fault that did not take effect. */
export interface FaultWarning {
  /**
   * Which of the three diagnoses this is, as the event name — so a consumer
   * routes on it instead of parsing prose. `fault_rule_unmatched` is the name
   * the network layer's run-end warning has always emitted and keeps.
   */
  event: "fault_rule_unmatched" | "fault_rule_unfired" | "fault_rule_uncounted";
  /**
   * Logger payload. `rule` carries the same label the network warning always
   * did, so an existing `fault_rule_unmatched` consumer keeps working; `layer`
   * is what distinguishes the three newly-covered layers from it.
   *
   * `matched` is absent on `fault_rule_uncounted`, deliberately: that row had
   * no usable counter, and publishing the coerced `0` would report a
   * measurement nobody made.
   */
  data: {
    rule: string;
    layer: FaultLayer;
    matched?: number;
    suppressed?: number;
    /**
     * On a network `fault_rule_unmatched` only, when a service worker
     * controlled a page of the run: it may have taken the requests the rule
     * was waiting for (see `PageResult.serviceWorker`).
     */
    serviceWorker?: ServiceWorkerReach;
  };
}

/**
 * The warnings a finished run should emit for faults that did not take effect.
 *
 * Same three diagnoses as `unfiredFaults`, shaped for a logger rather than an
 * assertion. It is a separate function because the run-end warning is the one
 * place that has to say something without being asked: a caller who never
 * writes the `unfiredFaults` assertion still gets told.
 *
 * That warning used to walk the network layer's compiled rules directly and
 * fire only on `matched === 0` — so a runtime, lifecycle or iframe fault that
 * never fired produced nothing at all, and neither did a network rule that
 * matched and was then declined by its own firing policy. Three of the four
 * layers and two of the three diagnoses were silent, which is the failure this
 * module exists to end: a check reporting nothing rather than reporting what it
 * could not check.
 */
export function faultWarnings(report: FaultStatsReport): FaultWarning[] {
  const out: FaultWarning[] = [];
  const sw = serviceWorkerReach(report);
  for (const f of faultFirings(report)) {
    if (f.fired > 0) continue;
    if (!f.counted) {
      out.push({ event: "fault_rule_uncounted", data: { rule: f.name, layer: f.layer } });
      continue;
    }
    const data = { rule: f.name, layer: f.layer, matched: f.matched };
    if (f.matched === 0) {
      out.push({
        event: "fault_rule_unmatched",
        data: f.layer === "network" && sw ? { ...data, serviceWorker: sw } : data,
      });
    } else {
      out.push({
        event: "fault_rule_unfired",
        data: f.suppressed > 0 ? { ...data, suppressed: f.suppressed } : data,
      });
    }
  }
  return out;
}
