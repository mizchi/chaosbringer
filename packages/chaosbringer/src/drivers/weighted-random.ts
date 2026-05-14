/**
 * The original chaosbringer action picker, packaged as a Driver.
 * Pure: depends only on the candidates and the step's RNG. Suitable as
 * the cheap base of a composite driver (e.g. `compositeDriver([ai, random])`).
 */
import { weightedPick } from "../random.js";
import type { Driver, DriverCandidate, DriverPick, DriverStep } from "./types.js";

export interface WeightedRandomDriverOptions {
  /**
   * Optional weight transform — receives the candidate's heuristic weight
   * and returns the effective weight. Use to plug coverage-feedback bias
   * (see `crawler.coverageWeightFor`) into the driver layer.
   */
  weightOf?: (c: DriverCandidate, step: DriverStep) => number;
}

export function weightedRandomDriver(
  opts: WeightedRandomDriverOptions = {},
): Driver {
  const weightOf = opts.weightOf ?? ((c) => c.weight);
  return {
    name: "weighted-random",
    async selectAction(step): Promise<DriverPick | null> {
      if (step.candidates.length === 0) return null;
      const picked = weightedPick(
        step.candidates,
        (c) => weightOf(c, step),
        step.rng,
      );
      return { kind: "select", index: picked.index, source: "weighted-random" };
    },
  };
}
