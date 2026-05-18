/**
 * Trace-derived rubric primitives. Operate on the probe.log produced by
 * the prepare CLI's probe loop (lines of the form `T h=NNN o=NNN`).
 *
 * Synchronous — the trace is plumbed into ScoringContext.probeTrace
 * before the rubric runs.
 */
import type { RubricCriterion } from "./types.ts";

interface ProbeSample {
  t: number;
  health: number;
  orders: number;
}

function parseTrace(trace: string): ProbeSample[] {
  const out: ProbeSample[] = [];
  for (const line of trace.split("\n")) {
    const m = line.match(/^(\d+)\s+h=(\d+)\s+o=(\d+)/);
    if (!m) continue;
    out.push({ t: Number(m[1]), health: Number(m[2]), orders: Number(m[3]) });
  }
  return out;
}

/**
 * Measure the *cost* of any SLO dip during the run, not just whether
 * the recovery window passed. Includes the cost of agent-induced
 * outages (e.g. restart-while-target-was-warming-up).
 *
 * Reads probe samples, identifies windows where /orders success rate
 * drops below `lowThreshold`, and FAILs if total seconds of breach
 * exceeds `maxBreachSec`.
 *
 * Different from `recoveredSlo`: that only looks at the final
 * recovery window. `restartCost` looks at the WHOLE trace, so an
 * agent that took the system down for 15s mid-run (e.g. restarting
 * the slow-warmup target) gets penalized even if the final window
 * is fine.
 */
export function restartCost(opts: {
  maxBreachSec?: number;
  lowThreshold?: number;
  windowSamples?: number;
  /**
   * Skip samples in the first N seconds of the run. Lets the baseline
   * target finish warming up (or the prepare-CLI race to settle) before
   * the criterion starts counting breaches.
   */
  skipFirstSec?: number;
  weight?: number;
} = {}): RubricCriterion {
  const maxBreachSec = opts.maxBreachSec ?? 5;
  const lowThreshold = opts.lowThreshold ?? 0.5;
  const windowSamples = opts.windowSamples ?? 5;
  const skipFirstSec = opts.skipFirstSec ?? 20;
  return {
    id: "restart-cost",
    description: `Total SLO breach (orders success < ${(lowThreshold * 100).toFixed(0)}%) ≤ ${maxBreachSec}s across the run`,
    weight: opts.weight ?? 4,
    failHint:
      "The agent's actions caused a sustained dip in customer success. " +
      "Restarting a slow-warming target, or applying a code change that " +
      "regressed behavior, both show up here. Verify SLO before AND after " +
      "your intervention.",
    check: ({ probeTrace }) => {
      if (!probeTrace) return true; // no trace; can't fail this criterion
      const all = parseTrace(probeTrace);
      const samples = all.filter((s) => s.t >= skipFirstSec);
      if (samples.length < windowSamples) return true;
      // Sliding window: for each window of N samples, compute the orders
      // success rate. If < lowThreshold, count those seconds toward breach.
      // We use the time delta between the first and last sample in the
      // window as the breach time contribution.
      let breachSec = 0;
      let i = 0;
      while (i + windowSamples <= samples.length) {
        const window = samples.slice(i, i + windowSamples);
        const oks = window.filter((s) => s.orders === 200).length;
        const rate = oks / window.length;
        if (rate < lowThreshold) {
          breachSec += (window[window.length - 1]!.t - window[0]!.t) || 1;
          i += windowSamples; // skip past this window once counted
        } else {
          i++;
        }
      }
      return breachSec <= maxBreachSec;
    },
  };
}

/**
 * Time-to-recovery as a scored criterion. From the first probe failure
 * to the start of the first sustained-green window, how many seconds?
 *
 * Synchronous, derived from probeTrace.
 */
export function timeToRecovery(opts: {
  maxSec?: number;
  greenStreak?: number;
  weight?: number;
} = {}): RubricCriterion {
  const maxSec = opts.maxSec ?? 120;
  const greenStreak = opts.greenStreak ?? 10;
  return {
    id: "time-to-recovery",
    description: `Time-to-first-sustained-green ≤ ${maxSec}s (${greenStreak} consecutive 200 samples)`,
    weight: opts.weight ?? 3,
    failHint:
      "The agent took too long to restore steady-state SLO. Often a " +
      "symptom of trial-and-error config tweaking. Diagnose first, edit once.",
    check: ({ probeTrace }) => {
      if (!probeTrace) return true;
      const samples = parseTrace(probeTrace);
      // Find first failure (orders != 200).
      const firstFailIdx = samples.findIndex((s) => s.orders !== 200);
      if (firstFailIdx === -1) return true; // never failed; perfect.
      const firstFailT = samples[firstFailIdx]!.t;
      // Find the START of the first window of `greenStreak` consecutive
      // 200s after the first failure.
      for (let i = firstFailIdx; i <= samples.length - greenStreak; i++) {
        const window = samples.slice(i, i + greenStreak);
        if (window.every((s) => s.orders === 200)) {
          const recoveryT = window[0]!.t - firstFailT;
          return recoveryT <= maxSec;
        }
      }
      // No sustained-green window ever achieved.
      return false;
    },
  };
}
