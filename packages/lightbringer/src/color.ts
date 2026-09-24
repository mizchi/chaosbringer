// ANSI color helpers for the summary output. Colour is for the terminal only:
// when stdout is piped / redirected (CI logs, `> file`, the docs captures) it
// falls back to plain text so nothing leaks escape codes. Honours NO_COLOR and
// FORCE_COLOR (the de-facto standards) plus an explicit PERF_COLOR=0|1 override.

export interface Palette {
  bold: (s: string) => string;
  dim: (s: string) => string;
  red: (s: string) => string;
  yellow: (s: string) => string;
  green: (s: string) => string;
  cyan: (s: string) => string;
}

/** Decide whether to emit ANSI codes, from env + TTY. Pure for testability. */
export function colorEnabled(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = Boolean(process.stdout?.isTTY),
): boolean {
  if (env.PERF_COLOR === "0" || env.NO_COLOR) return false;
  if (env.PERF_COLOR === "1" || env.FORCE_COLOR) return true;
  return isTTY;
}

export function makePalette(enabled: boolean): Palette {
  const wrap =
    (open: number, close: number) =>
    (s: string): string =>
      enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s;
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    yellow: wrap(33, 39),
    green: wrap(32, 39),
    cyan: wrap(36, 39),
  };
}

/** The palette the summary uses, resolved once from the environment. */
export const palette: Palette = makePalette(colorEnabled());
