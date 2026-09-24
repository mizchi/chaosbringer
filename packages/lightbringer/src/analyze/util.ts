// Shared primitives for the analyze layer (pure CDP/Performance-event → report
// fragment functions). Nothing here touches Playwright or the network/filesystem.

/** Round to one decimal place (every report number goes through this). */
export function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** A measured region in epoch-ms. Spans and app measures both reduce to this. */
export interface EpochWindow {
  startEpochMs: number;
  endEpochMs: number;
}
