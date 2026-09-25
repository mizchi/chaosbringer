/**
 * A driver that hunts for the slowest interaction — the perf counterpart of
 * coverage feedback (`coverageWeightFor`), which hunts for the newest code.
 *
 * It learns what each step costs from `DriverStep.lastActionPerf`: after an
 * action, the next step carries that action's span, keyed by its perfKey.
 * A candidate's own perfKey (`candidatePerfKey`) is the key its span will
 * carry, so a candidate whose key was expensive earlier in the crawl — or in
 * a prior crawl's report — is weighted by that cost and picked more often.
 *
 * Cost is `blockingMs + interactionMs`: main-thread time the step held and
 * the input-to-paint latency the user felt. Duration is left out on purpose;
 * it includes the settle wait and network time, so a step that is slow only
 * because its request is slow would outrank one that freezes the page.
 *
 * Candidates never measured are explored two ways: with probability
 * `epsilon` the pick is uniform among them, and otherwise each is weighted
 * as if it cost the average of the measured candidates beside it — so the
 * first key measured, cheap or not, does not crowd out the ones not tried.
 */
import { candidatePerfKey } from "../perf-key.js";
import { weightedPick } from "../random.js";
import type { CrawlReport, LastActionPerf } from "../types.js";
import type { Driver, DriverCandidate, DriverPick, DriverStep } from "./types.js";

export interface PerfSeekingDriverOptions {
  /**
   * Probability, per step, of picking uniformly among the candidates whose
   * key has no measurement yet (when there are any), instead of by cost.
   * Default: 0.2.
   */
  epsilon?: number;
  /**
   * A previous crawl's report: every action span in it seeds the observed
   * cost of its key, so the first steps of this crawl already lean toward
   * what was slow last time. Keys drop the origin, so a report from another
   * port or host matches. Needs `perf` on in that crawl too; a report
   * without action spans seeds nothing.
   */
  prior?: Pick<CrawlReport, "actions">;
  /**
   * Where the one "perf is off" warning goes. Default: `console.warn`.
   */
  onWarn?: (message: string) => void;
}

/**
 * Added to every measured key's mean cost, so a step measured at 0ms is
 * still picked now and then — cheap once is not cheap always — while a key
 * that cost 200ms outweighs it 200 to 1.
 */
export const PERF_SEEKING_COST_FLOOR_MS = 1;

/**
 * Width of the buckets a key's mean cost is rounded down into before it
 * becomes a weight. Two runs of the same seed measure the same click a
 * millisecond or two apart, and with raw costs that jitter moves every pick
 * boundary: a cheap key at 2.3ms weighs 3.3 against 1.4 at 0.4ms, so the
 * same roll lands on a different near-tied candidate and the runs diverge
 * from there. Bucketed, every cheap key (0–4.9ms) weighs the floor alike,
 * and a 200ms key moves only when its mean crosses a bucket edge, which
 * jitter of a few ms rarely does and which shifts its weight by ~2% when it
 * does. It cannot make the picks immune to noise — a mean sitting on an
 * edge still flips — only far less likely to change. 5ms is under the
 * cost differences the driver is meant to rank (a long task is 50ms+).
 */
export const PERF_SEEKING_COST_BUCKET_MS = 5;

/** Default `epsilon`. */
export const PERF_SEEKING_DEFAULT_EPSILON = 0.2;

/** The cost a span contributes to its key. */
export function perfSeekingCost(p: Pick<LastActionPerf, "cpu" | "interaction">): number {
  return p.cpu.blockingMs + (p.interaction?.maxDurationMs ?? 0);
}

function bucketCost(ms: number): number {
  return Math.floor(ms / PERF_SEEKING_COST_BUCKET_MS) * PERF_SEEKING_COST_BUCKET_MS;
}

export function perfSeekingDriver(opts: PerfSeekingDriverOptions = {}): Driver {
  const epsilon = opts.epsilon ?? PERF_SEEKING_DEFAULT_EPSILON;
  if (!(epsilon >= 0 && epsilon <= 1)) {
    throw new Error(`perfSeekingDriver: epsilon must be in [0, 1], got ${epsilon}`);
  }
  const warn = opts.onWarn ?? ((m: string) => console.warn(m));

  const costs = new Map<string, { n: number; total: number }>();
  const observe = (key: string, cost: number) => {
    const entry = costs.get(key);
    if (entry) {
      entry.n += 1;
      entry.total += cost;
    } else {
      costs.set(key, { n: 1, total: cost });
    }
  };
  for (const action of opts.prior?.actions ?? []) {
    if (action.perf) observe(action.perf.key, perfSeekingCost(action.perf));
  }

  // The crawler hands every attempt of a step the same object until the
  // next action ran, and a step can be attempted more than once (a skipped
  // or refused pick). Counting by identity counts each measurement once.
  let lastObserved: LastActionPerf | undefined;
  let sawPerf = false;
  let perfOff = false;

  const uniform = (items: readonly DriverCandidate[], step: DriverStep) =>
    weightedPick(items, () => 1, step.rng);

  return {
    name: "perf-seeking",
    async selectAction(step): Promise<DriverPick | null> {
      if (step.candidates.length === 0) return null;

      const measuredStep = step.lastActionPerf;
      if (measuredStep) {
        sawPerf = true;
        perfOff = false;
        if (measuredStep !== lastObserved) {
          lastObserved = measuredStep;
          observe(measuredStep.key, perfSeekingCost(measuredStep));
        }
      } else if (!sawPerf && !perfOff && step.history.length > 0) {
        // An action already ran on this page and the step still carries
        // no measurement, and none ever arrived: perf (or `perf.actions`)
        // is off. Absence on a page's first step says nothing — that step
        // has no previous action — so this waits for a second one.
        perfOff = true;
        warn(
          "perfSeekingDriver: no action perf measured (is `perf` on with `perf.actions` not false?); picking uniformly",
        );
      }
      if (perfOff) {
        return { kind: "select", index: uniform(step.candidates, step).index, source: "perf-seeking" };
      }

      const measured: Array<{ candidate: DriverCandidate; cost: number }> = [];
      const unmeasured: DriverCandidate[] = [];
      for (const candidate of step.candidates) {
        // Keyed by the route the page is on (`currentUrl`), as the crawler
        // keys the span: after a click that navigated, the visit URL names a
        // screen these candidates are not on.
        const entry = costs.get(candidatePerfKey(step, candidate));
        if (entry) measured.push({ candidate, cost: bucketCost(entry.total / entry.n) });
        else unmeasured.push(candidate);
      }

      if (unmeasured.length > 0 && step.rng.next() < epsilon) {
        const picked = uniform(unmeasured, step);
        return { kind: "select", index: picked.index, source: "perf-seeking" };
      }
      // An unmeasured candidate is weighted as costing what a measured one on
      // this screen costs on average. Leaving it out would lock the driver
      // onto the first key it measured — cheap or not — and leave finding the
      // slow one to `epsilon` alone; while nothing here is measured, every
      // weight is the floor and the pick is uniform.
      const average =
        measured.length > 0 ? measured.reduce((sum, m) => sum + m.cost, 0) / measured.length : 0;
      const weighted = [
        ...measured,
        ...unmeasured.map((candidate) => ({ candidate, cost: average })),
      ];
      const picked = weightedPick(weighted, (m) => m.cost + PERF_SEEKING_COST_FLOOR_MS, step.rng).candidate;
      return { kind: "select", index: picked.index, source: "perf-seeking" };
    },
  };
}
