// Shared primitives for the analyze layer (pure CDP/Performance-event → report
// fragment functions). Nothing here touches Playwright or the network/filesystem.

/** Round to one decimal place (every report number goes through this). */
export function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Bytes → KB with one decimal (the report / CLI "KB" figure). */
export function kb(bytes: number): number {
  return Math.round(bytes / 102.4) / 10;
}

/** A measured region in epoch-ms. Spans and app measures both reduce to this. */
export interface EpochWindow {
  startEpochMs: number;
  endEpochMs: number;
}

/** Whether epoch-ms `t` falls inside `w`, inclusive at both ends. */
export function inEpochWindow(t: number, w: EpochWindow): boolean {
  return t >= w.startEpochMs && t <= w.endEpochMs;
}
