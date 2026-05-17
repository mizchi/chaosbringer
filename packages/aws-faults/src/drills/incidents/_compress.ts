/**
 * Helpers for incident-replay drills: shrink real-world timelines (often
 * hours) into drill-friendly windows (seconds-to-minutes) while preserving
 * the relative shape of onset → peak → recovery.
 */
import type { Phase } from "../../orchestrator.ts";
import type { Rule } from "../../types.ts";

export interface PhaseTemplate {
  label: string;
  /** Real-world duration of this phase, in minutes. */
  realMinutes: number;
  rules: Rule[];
}

/**
 * compressTimeline rescales a list of real-world phases to fit a total drill
 * duration. The relative ratios between phases are preserved exactly; only
 * absolute time is compressed.
 *
 * Example: a 5-hour incident with [onset=15min, peak=2h, recovery=2h45min]
 * compressed to 60 seconds becomes [onset=3s, peak=24s, recovery=33s].
 */
export function compressTimeline(
  templates: PhaseTemplate[],
  totalDrillMs: number,
): Phase[] {
  const totalRealMin = templates.reduce((sum, t) => sum + t.realMinutes, 0);
  if (totalRealMin <= 0) return [];
  return templates.map((t) => ({
    label: t.label,
    durationMs: Math.max(500, Math.round((t.realMinutes / totalRealMin) * totalDrillMs)),
    rules: t.rules,
  }));
}
