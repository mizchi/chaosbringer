/**
 * Scenario helpers — `defineScenario` is a tiny convenience that
 * validates step names are unique (so the step rollup in `LoadReport`
 * is unambiguous) and gives a typed entry point.
 *
 * The think-time picker lives here so workers and tests can both use
 * it without pulling in the runner. It uses the standard global
 * `Math.random` — load runs are not seeded for determinism on purpose
 * (workers running with the same think-time pattern defeat the point
 * of load testing).
 */
import type { Scenario, ScenarioStep, ThinkTime } from "./types.js";

export function defineScenario(spec: {
  name: string;
  steps: ReadonlyArray<ScenarioStep>;
  thinkTime?: ThinkTime;
  beforeIteration?: Scenario["beforeIteration"];
  afterIteration?: Scenario["afterIteration"];
}): Scenario {
  if (spec.steps.length === 0) {
    throw new Error(`defineScenario(${spec.name}): steps is empty`);
  }
  const seen = new Set<string>();
  for (const s of spec.steps) {
    if (seen.has(s.name)) {
      throw new Error(`defineScenario(${spec.name}): duplicate step name "${s.name}"`);
    }
    seen.add(s.name);
  }
  return {
    name: spec.name,
    steps: spec.steps,
    thinkTime: spec.thinkTime,
    beforeIteration: spec.beforeIteration,
    afterIteration: spec.afterIteration,
  };
}

const DEFAULT_THINK_TIME: Required<ThinkTime> = {
  minMs: 1000,
  maxMs: 3000,
  distribution: "uniform",
};

/** Pick a think-time wait in ms, honouring an override chain. */
export function pickThinkTimeMs(
  ...overrides: ReadonlyArray<ThinkTime | undefined>
): number {
  const merged: Required<ThinkTime> = { ...DEFAULT_THINK_TIME };
  for (const o of overrides) {
    if (!o) continue;
    if (o.minMs !== undefined) merged.minMs = o.minMs;
    if (o.maxMs !== undefined) merged.maxMs = o.maxMs;
    if (o.distribution !== undefined) merged.distribution = o.distribution;
  }
  if (merged.distribution === "none") return 0;
  const min = Math.max(0, merged.minMs);
  const max = Math.max(min, merged.maxMs);
  if (min === max) return min;
  if (merged.distribution === "gaussian") {
    // Box-Muller transform; clamp σ so the bulk lands inside [min,max].
    const mid = (min + max) / 2;
    const sigma = (max - min) / 4;
    const u1 = Math.max(Number.EPSILON, Math.random());
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.min(max, Math.max(min, mid + sigma * z));
  }
  return min + Math.random() * (max - min);
}
