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

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;
  describe("colorEnabled", () => {
    it("NO_COLOR が設定されていれば TTY でも無効になること", () => {
      expect(colorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
    });
    it("PERF_COLOR=0 が NO_COLOR と同様に無効化すること", () => {
      expect(colorEnabled({ PERF_COLOR: "0" }, true)).toBe(false);
    });
    it("PERF_COLOR=1 が非TTYでも有効化すること", () => {
      expect(colorEnabled({ PERF_COLOR: "1" }, false)).toBe(true);
    });
    it("FORCE_COLOR が非TTYでも有効化すること", () => {
      expect(colorEnabled({ FORCE_COLOR: "1" }, false)).toBe(true);
    });
    it("env 指定が無ければ TTY の有無で決まること", () => {
      expect(colorEnabled({}, true)).toBe(true);
      expect(colorEnabled({}, false)).toBe(false);
    });
    it("PERF_COLOR=0 が FORCE_COLOR より優先されること", () => {
      expect(colorEnabled({ PERF_COLOR: "0", FORCE_COLOR: "1" }, true)).toBe(false);
    });
  });
  describe("makePalette", () => {
    it("無効時は入力をそのまま返すこと", () => {
      const p = makePalette(false);
      expect(p.red("x")).toBe("x");
      expect(p.bold("x")).toBe("x");
    });
    it("有効時は ANSI コードで囲むこと", () => {
      const p = makePalette(true);
      expect(p.red("x")).toBe("\x1b[31mx\x1b[39m");
      expect(p.dim("x")).toBe("\x1b[2mx\x1b[22m");
    });
  });
}
