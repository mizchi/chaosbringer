/**
 * Tiny seeded RNG used by the package's own unit tests so they don't have
 * to depend on chaosbringer. Not part of the public surface — only re-export
 * from `index.ts` if a downstream legitimately needs the same generator
 * function (most won't; they'll bring their own RNG).
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
