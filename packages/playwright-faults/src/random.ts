/**
 * Seeded mulberry32 RNG — the same sequence as chaosbringer's `createRng`.
 *
 * Started as a test helper so this package's unit tests did not depend on
 * chaosbringer. It is now re-exported from `@mizchi/playwright-faults/network`
 * because an adapter that runs `FaultRule`s outside chaosbringer has to draw
 * the same numbers for a seed to mean the same run. It is still not on the
 * root entry: most consumers bring their own RNG.
 */

import type { Rng } from "./types.js";

export interface SeededRng extends Rng {
  readonly seed: number;
}

export function createRng(seed: number): SeededRng {
  let state = seed >>> 0;
  return {
    seed,
    next(): number {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}
