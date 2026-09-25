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
 * Cost is the larger of `blockingMs` and `interactionMs`: main-thread time
 * the step held, or the input-to-paint latency the user felt. Duration is
 * left out on purpose; it includes the settle wait and network time, so a
 * step that is slow only because its request is slow would outrank one that
 * freezes the page.
 *
 * Candidates never measured are explored two ways: with probability
 * `epsilon` the pick is uniform among them, and otherwise each is weighted
 * as if it cost the average of the measured candidates beside it — so the
 * first key measured, cheap or not, does not crowd out the ones not tried.
 */
import { candidatePerfKey } from "../perf-key.js";
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
 * that cost 200ms (bucketed to ~174, see `perfSeekingBucketCost`)
 * outweighs it ~175 to 1.
 */
export const PERF_SEEKING_COST_FLOOR_MS = 1;

/**
 * @deprecated No longer used. Costs used to be floored to 5 ms buckets,
 * which left two runs of one seed apart whenever a noisy mean straddled a
 * 5 ms edge (162 vs 177 ms is three buckets apart). They are now bucketed
 * on a log scale: see `PERF_SEEKING_COST_THRESHOLD_MS`,
 * `PERF_SEEKING_COST_BUCKET_RATIO` and `perfSeekingBucketCost`. Kept, with
 * its old value, so existing imports still compile.
 */
export const PERF_SEEKING_COST_BUCKET_MS = 5;

/**
 * Mean costs under this weigh the floor alike: a cheap click reads 0 ms in
 * one run and 16 or 24 ms (one or two frames of interaction latency) in the
 * next, and none of that is what the driver hunts — a long task is 50 ms+.
 * It is also the lowest bucket edge; see `PERF_SEEKING_COST_BUCKET_RATIO`.
 */
export const PERF_SEEKING_COST_THRESHOLD_MS = 42;

/**
 * Above the threshold, each bucket is this many times wider than the one
 * below it: edges at 42, 63, 94.5, 142, 213, 319, 478, 718, 1077 ms… Noise in
 * a timing is roughly proportional to it — a 200 ms handler reads 200–209,
 * one that runs beside a GC reads 160–180 — so a fixed-width bucket is too
 * narrow for slow steps and needlessly wide for fast ones, while a ratio
 * keeps every bucket ±20% wide. The 42 ms anchor puts the edges ≥4.5% away
 * from the round costs (50, 80, 100, 150, 200, 300, 500, 1000 ms…) a test
 * page or a throttled handler tends to produce. Two buckets still differ by
 * 1.5x in weight, so a 200 ms key keeps outweighing an 80 ms one ~2.2 to 1
 * and a cheap one ~175 to 1.
 */
export const PERF_SEEKING_COST_BUCKET_RATIO = 1.5;

/** Default `epsilon`. */
export const PERF_SEEKING_DEFAULT_EPSILON = 0.2;

/**
 * The cost a span contributes to its key: the larger of blocking time and
 * interaction latency.
 *
 * Not their sum. A busy click handler shows up in both — its long task is
 * the blocking time, and it is also most of the interaction's duration — so
 * the sum counts one freeze twice. Worse, the two do not arrive together:
 * the long task is in by the time the next step reads `lastActionPerf`, but
 * the browser reports the interaction only after the paint that ends it,
 * which often lands after the span was read. The same 200 ms click then read
 * 200 in one run and 400 in the next, and later in the final report (where
 * the interaction always is) 400 again — so the sum made the driver's view
 * of a key depend on a race, and a `prior` disagree with the live reading.
 * The max reads ~200 either way, and still counts an interaction that is
 * slow without a long task.
 */
export function perfSeekingCost(p: Pick<LastActionPerf, "cpu" | "interaction">): number {
  return Math.max(p.cpu.blockingMs, p.interaction?.maxDurationMs ?? 0);
}

/**
 * The weight-cost a key's mean cost `ms` stands for: 0 below
 * `PERF_SEEKING_COST_THRESHOLD_MS`, otherwise the geometric middle of its
 * log-scale bucket (threshold × ratio^k … ratio^(k+1)). Every mean in one
 * bucket gives exactly the same number, so jitter that stays inside a
 * bucket cannot move a pick. Computed by repeated multiplication rather than
 * `Math.log`, so an edge is the same float on every platform.
 */
export function perfSeekingBucketCost(ms: number): number {
  if (!(ms >= PERF_SEEKING_COST_THRESHOLD_MS)) return 0; // also NaN
  if (!Number.isFinite(ms)) return Number.MAX_VALUE;
  let lo = PERF_SEEKING_COST_THRESHOLD_MS;
  while (lo * PERF_SEEKING_COST_BUCKET_RATIO <= ms) lo *= PERF_SEEKING_COST_BUCKET_RATIO;
  return lo * Math.sqrt(PERF_SEEKING_COST_BUCKET_RATIO);
}

/**
 * `weightedPick` with the roll drawn by the caller, so every step draws the
 * same number of values whichever branch picks (see `selectAction`).
 */
function pickByRoll<T>(items: readonly T[], weightOf: (item: T) => number, roll: number): T {
  let total = 0;
  for (const item of items) total += weightOf(item);
  let left = roll * total;
  for (const item of items) {
    left -= weightOf(item);
    if (left < 0) return item;
  }
  return items[items.length - 1]!;
}

export function perfSeekingDriver(opts: PerfSeekingDriverOptions = {}): Driver {
  const epsilon = opts.epsilon ?? PERF_SEEKING_DEFAULT_EPSILON;
  if (!(epsilon >= 0 && epsilon <= 1)) {
    throw new Error(`perfSeekingDriver: epsilon must be in [0, 1], got ${epsilon}`);
  }
  const warn = opts.onWarn ?? ((m: string) => console.warn(m));

  // Looked up by key only, never iterated: the weighting walks
  // `step.candidates`, so the order measurements arrived in cannot reorder
  // it. Each cost is rounded to a whole millisecond before it is summed, so
  // `total` is an exact integer and a key's mean is the same whatever order
  // its measurements came in (float sums are not: 14.7 + 0.2 + 0.1 and
  // 0.1 + 0.2 + 14.7 differ in the last bit, which is enough to put a mean
  // on either side of a bucket edge).
  const costs = new Map<string, { n: number; total: number }>();
  const observe = (key: string, rawCost: number) => {
    const cost = Math.round(rawCost);
    if (!Number.isFinite(cost)) return;
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

  return {
    name: "perf-seeking",
    async selectAction(step): Promise<DriverPick | null> {
      if (step.candidates.length === 0) return null;

      // Exactly two draws per step, whichever branch picks: the pick roll,
      // then the epsilon roll. `step.rng` is the crawler's, shared with
      // every later step (and with fault decisions), so a step that drew
      // once on one branch and twice on another would shift every roll
      // after it whenever a measurement flipped the branch — one noisy
      // step would reshuffle the rest of the crawl instead of one pick.
      const pickRoll = step.rng.next();
      const exploreRoll = step.rng.next();

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
        const picked = pickByRoll(step.candidates, () => 1, pickRoll);
        return { kind: "select", index: picked.index, source: "perf-seeking" };
      }

      // Built in `step.candidates` order — the page's order, not the order
      // costs were first measured — so the same screen and the same bucketed
      // costs give the same list, and so the same pick for the same roll.
      const bucketed: Array<{ candidate: DriverCandidate; cost: number | undefined }> = step.candidates.map(
        (candidate) => {
          // Keyed by the route the page is on (`currentUrl`), as the crawler
          // keys the span: after a click that navigated, the visit URL names a
          // screen these candidates are not on.
          const entry = costs.get(candidatePerfKey(step, candidate));
          return { candidate, cost: entry ? perfSeekingBucketCost(entry.total / entry.n) : undefined };
        },
      );
      const unmeasured = bucketed.filter((b) => b.cost === undefined).map((b) => b.candidate);
      const measuredCosts = bucketed.flatMap((b) => (b.cost === undefined ? [] : [b.cost]));

      if (unmeasured.length > 0 && exploreRoll < epsilon) {
        const picked = pickByRoll(unmeasured, () => 1, pickRoll);
        return { kind: "select", index: picked.index, source: "perf-seeking" };
      }
      // An unmeasured candidate is weighted as costing what a measured one on
      // this screen costs on average. Leaving it out would lock the driver
      // onto the first key it measured — cheap or not — and leave finding the
      // slow one to `epsilon` alone; while nothing here is measured, every
      // weight is the floor and the pick is uniform.
      const average =
        measuredCosts.length > 0 ? measuredCosts.reduce((sum, c) => sum + c, 0) / measuredCosts.length : 0;
      const picked = pickByRoll(
        bucketed,
        (b) => (b.cost ?? average) + PERF_SEEKING_COST_FLOOR_MS,
        pickRoll,
      ).candidate;
      return { kind: "select", index: picked.index, source: "perf-seeking" };
    },
  };
}
