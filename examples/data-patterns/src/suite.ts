/**
 * The invariants every case runs: the four `dataSafety()` presets plus
 * `notBlank()`, the same suite for every entry and every run, so no entry
 * is judged by a check picked for it.
 */

import { type Invariant, invariants } from "chaosbringer";

export function catalogSuite(): Invariant[] {
  return [...invariants.dataSafety(), invariants.notBlank()];
}

export interface CountedSuite {
  invariants: Invariant[];
  /** How many times each invariant's check ran so far, by name; 0 for one that never did. */
  runs(): Record<string, number>;
}

/**
 * `suite` with each check wrapped in a counter. A clean run proves nothing
 * if a check never ran (a `when` it isn't evaluated in, a `urlPattern` that
 * matches no page), so the verdict reads these counts.
 */
export function counted(suite: readonly Invariant[]): CountedSuite {
  const runs = new Map<string, number>(suite.map((inv) => [inv.name, 0]));
  return {
    invariants: suite.map((inv) => ({
      ...inv,
      check: (ctx) => {
        runs.set(inv.name, (runs.get(inv.name) ?? 0) + 1);
        return inv.check(ctx);
      },
    })),
    runs: () => Object.fromEntries(runs),
  };
}
