/**
 * Composite + sampling driver combinators.
 *
 * `compositeDriver([a, b, c])` asks each child in order until one returns
 * a concrete pick. `null` from a child means "I have no opinion" — useful
 * for budget-gated AI drivers that should silently fall back to a random
 * driver. A `kind: "skip"` pick is treated as a deliberate decision and
 * is NOT overridden by later drivers.
 *
 * `samplingDriver({ every: N, driver })` only delegates every N-th step;
 * other steps return `null` so the outer composite can take over. Pair
 * with a cheap base driver to get "AI every 3rd step, random otherwise"
 * patterns without bespoke wiring.
 */
import type { ActionResult } from "../types.js";
import type { Driver, DriverPick, DriverStep } from "./types.js";

export interface CompositeDriverOptions {
  /** Optional name override. Default: "composite". */
  name?: string;
}

export function compositeDriver(
  drivers: ReadonlyArray<Driver>,
  options: CompositeDriverOptions = {},
): Driver {
  if (drivers.length === 0) {
    throw new Error("compositeDriver requires at least one child driver");
  }
  return {
    name: options.name ?? `composite(${drivers.map((d) => d.name).join(",")})`,
    async selectAction(step: DriverStep): Promise<DriverPick | null> {
      for (const d of drivers) {
        const pick = await d.selectAction(step);
        if (pick !== null) return pick;
      }
      return null;
    },
    onActionComplete(action: ActionResult, step: DriverStep) {
      for (const d of drivers) d.onActionComplete?.(action, step);
    },
    onPageStart(url: string) {
      for (const d of drivers) d.onPageStart?.(url);
    },
    onPageEnd(url: string) {
      for (const d of drivers) d.onPageEnd?.(url);
    },
  };
}

export interface SamplingDriverOptions {
  /** Underlying driver to invoke when sampled. */
  driver: Driver;
  /**
   * One in every `every` steps invokes the driver. `every: 1` is
   * "every step", `every: 3` is "every third step", `every: 0` disables.
   * Default: 3.
   */
  every?: number;
  /**
   * Optional fixed offset (steps before the first invocation). Default: 0,
   * meaning step 0 calls the driver.
   */
  offset?: number;
  name?: string;
}

export function samplingDriver(options: SamplingDriverOptions): Driver {
  const every = options.every ?? 3;
  const offset = options.offset ?? 0;
  const inner = options.driver;
  return {
    name: options.name ?? `sampling(every=${every},${inner.name})`,
    async selectAction(step: DriverStep): Promise<DriverPick | null> {
      if (every <= 0) return null;
      const since = step.stepIndex - offset;
      if (since < 0 || since % every !== 0) return null;
      return inner.selectAction(step);
    },
    onActionComplete(action, step) {
      inner.onActionComplete?.(action, step);
    },
    onPageStart(url) {
      inner.onPageStart?.(url);
    },
    onPageEnd(url) {
      inner.onPageEnd?.(url);
    },
  };
}

export interface ProbabilityDriverOptions {
  driver: Driver;
  /** Probability in [0, 1] of invoking the inner driver each step. */
  probability: number;
  name?: string;
}

export function probabilityDriver(options: ProbabilityDriverOptions): Driver {
  const inner = options.driver;
  const p = Math.max(0, Math.min(1, options.probability));
  return {
    name: options.name ?? `probability(p=${p},${inner.name})`,
    async selectAction(step): Promise<DriverPick | null> {
      if (p <= 0) return null;
      if (step.rng.next() >= p) return null;
      return inner.selectAction(step);
    },
    onActionComplete(action, step) {
      inner.onActionComplete?.(action, step);
    },
    onPageStart(url) {
      inner.onPageStart?.(url);
    },
    onPageEnd(url) {
      inner.onPageEnd?.(url);
    },
  };
}
